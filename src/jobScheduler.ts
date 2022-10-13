import nodeSchedule from 'node-schedule'
import Redis from 'ioredis'
import ms from 'ms'
import _debug from 'debug'
import {
  RunDelayed,
  Deferred,
  Delayed,
  Recurring,
  StopFn,
  Events,
} from './types'
import { defer, getPreviousDate } from './util'
import { RedisOptions } from 'ioredis'
import EventEmitter from 'eventemitter3'

const debug = _debug('ha-job-scheduler')

/**
 * Uses Redis to scheduling recurring jobs or delayed jobs.
 */
export const jobScheduler = (opts?: RedisOptions) => {
  const redis = opts ? new Redis(opts) : new Redis()
  const stopFns: StopFn[] = []
  const emitter = new EventEmitter<Events>()
  const emit = (event: Events, data: object) => {
    emitter.emit(event, { type: event, ...data })
  }

  /**
   * Attempt to get a lock for the lock key, `lockKey`, lasting `lockExpireMs`.
   */
  const getLock = (lockKey: string, lockExpireMs = ms('1m')) =>
    redis.set(lockKey, process.pid, 'PX', lockExpireMs, 'NX')

  const scheduleRecurring: Recurring = (id, rule, runFn, options = {}) => {
    const { lockExpireMs, persistScheduledMs } = options
    const key = `recurring:${id}`
    let deferred: Deferred<void>
    // Should invocations be persisted to Redis
    const shouldPersistInvocations =
      typeof persistScheduledMs === 'number' && persistScheduledMs > 0
    const persistKey = `${key}:lastRun`

    // Called for each invocation
    const runJob = async (date: Date) => {
      deferred = defer()
      emit('schedule:recurring', { id, rule, date })
      const scheduledTime = date.getTime()
      const lockKey = `${key}:${scheduledTime}:lock`
      // Attempt to get an exclusive lock.
      const locked = await getLock(lockKey, lockExpireMs)
      // Lock was obtained
      if (locked) {
        debug('lock obtained - id: %s date: %s', id, date)
        // Persist invocation
        if (shouldPersistInvocations) {
          await redis.set(persistKey, scheduledTime, 'PX', persistScheduledMs)
        }
        // Run job
        await runFn(date)
        emit('run:recurring', { id, rule, date })
      }
      deferred.done()
    }

    // Schedule last missed job if needed
    if (shouldPersistInvocations) {
      // Get previous invocation date
      const date = getPreviousDate(rule)
      const expectedLastRunTime = date.getTime()
      // Get last run time
      redis.get(persistKey).then((val) => {
        // Last run time exists and job was run prior to expected last run
        if (val && Number.parseInt(val, 10) < expectedLastRunTime) {
          debug('missed job - id: %s date: %s', id, date)
          // Run job with previous invocation date
          runJob(date)
        }
      })
    }
    // Schedule recurring job
    const schedule = nodeSchedule.scheduleJob(rule, runJob)
    /**
     * Stop the scheduler. Awaits the completion of the current invocation
     * before resolving.
     */
    const stop = () => {
      schedule.cancel()
      return deferred?.promise
    }
    stopFns.push(stop)

    return { schedule, stop }
  }

  const getDelayedKey = (id: string) => `delayed:${id}`

  const scheduleDelayed: Delayed = async (id, data, scheduleFor) => {
    const key = getDelayedKey(id)
    // Timestamp for delivery
    const score =
      typeof scheduleFor === 'number'
        ? new Date().getTime() + scheduleFor
        : scheduleFor.getTime()
    // Add data to sorted set
    const res = await redis.zadd(key, score, Buffer.from(data))
    const success = res === 1
    if (success) {
      emit('schedule:delayed', { id, scheduleFor })
    }
    return success
  }

  const runDelayed: RunDelayed = (id, runFn, options = {}) => {
    const { rule = '* * * * *', lockExpireMs, limit = 100 } = options
    const key = getDelayedKey(id)
    let deferred: Deferred<void>

    /**
     * Get delayed items where the delayed timestamp is <= now.
     * Returns up to limit number of items.
     */
    const getItems = (upper: number) =>
      redis.zrangebyscoreBuffer(key, '-inf', upper, 'LIMIT', 0, limit)

    // Poll Redis according to rule frequency
    const schedule = nodeSchedule.scheduleJob(rule, async (date) => {
      deferred = defer()
      const scheduledTime = date.getTime()
      const lockKey = `${key}:${scheduledTime}:lock`
      // Attempt to get an exclusive lock. Lock expires in 1 minute.
      const locked = await getLock(lockKey, lockExpireMs)
      if (locked) {
        debug('lock obtained - id: %s date: %s', id, date)
        const now = new Date().getTime()
        const items = await getItems(now)
        if (items.length) {
          debug('delayed items found - id: %s num: %d', id, items.length)
          // Call run fn
          // TODO: Maybe return an array of tuples with the data and the score (scheduled time)
          await runFn(items)
          // Remove delayed items
          await redis.zremrangebyscore(key, '-inf', now)
          emit('run:delayed', { id, items: items.length })
        }
      }
      deferred.done()
    })

    /**
     * Stop the scheduler. Awaits the completion of the current invocation
     * before resolving.
     */
    const stop = () => {
      schedule.cancel()
      return deferred?.promise
    }
    stopFns.push(stop)

    return { schedule, stop }
  }

  const stop = async () => {
    await Promise.all(stopFns.map((stop) => stop()))
    redis.disconnect()
  }

  return {
    /**
     * Schedule a recurring job. `runFn` will be called for every invocation of the rule.
     *
     * Set `persistScheduledMs` to a value greater than the frequency of the cron
     * rule to guarantee that the last missed job will be run. This is useful for
     * infrequent jobs that cannot be missed. For example, if you have a job that runs
     * at 6am daily, you might want to set `persistScheduledMs` to `ms('25h')` so that
     * a missed run will be attempted up to one hour past the scheduled invocation.
     *
     * The `id` should be unique for the rule/runFn pair.
     *
     * Guarantees at most one delivery.
     */
    scheduleRecurring,
    /**
     * Schedule data to be delivered at a later date. Duplicate payloads
     * will be ignored. `scheduleFor` accepts a number of milliseconds
     * in the future or a date. Use in conjunction with `runDelayed`.
     *
     * Returns a boolean indicating if the item  was successfully scheduled.
     */
    scheduleDelayed,
    /**
     * Check for delayed items according to the recurrence rule. Default
     * interval is every minute. Calls `runFn` for the batch of items where
     * the delayed timestamp is <= now. The default number of items to
     * retrieve at one time is 100.
     *
     * The `id` parameter should match the `id` passed to `scheduleDelayed`.
     *
     * Guarantees at least one delivery.
     */
    runDelayed,
    /**
     * Call stop on all schedulers and close the Redis connection
     */
    stop,
    emitter,
  }
}
