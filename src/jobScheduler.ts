import nodeSchedule from 'node-schedule'
import Redis from 'ioredis'
import ms from 'ms'
import _debug from 'debug'
import { RunDelayed, Deferred, Delayed, Recurring, StopFn } from './types'
import { defer, getPreviousDate } from './util'
import { RedisOptions } from 'ioredis'

const debug = _debug('ha-job-scheduler')

export const jobScheduler = (opts?: RedisOptions) => {
  const redis = opts ? new Redis(opts) : new Redis()
  const stopFns: StopFn[] = []

  /**
   * Schedule a recurring job. `runFn` will be called for every invocation of the rule.
   * Set `persistScheduledMs` to a value greater than the frequency of the cron
   * rule to guarantee that the last missed job will be run. This is useful for
   * infrequent jobs that cannot be missed.
   *
   * Guarantees at most one delivery.
   */
  const scheduleRecurring: Recurring = (id, rule, runFn, options = {}) => {
    const { lockExpireMs = ms('1m'), persistScheduledMs } = options
    let deferred: Deferred<void>
    // Should invocations be persisted to Redis
    const shouldPersistInvocations =
      typeof persistScheduledMs === 'number' && persistScheduledMs > 0
    const persistKey = `lastRun:${id}`

    // Called for each invocation
    const runJob = async (date: Date) => {
      const scheduledTime = date.getTime()
      const lockKey = `schedulingLock:${id}:${scheduledTime}`
      // The process that obtained the lock
      const val = process.pid
      // Attempt to get an exclusive lock.
      const locked = await redis.set(lockKey, val, 'PX', lockExpireMs, 'NX')
      // Lock was obtained
      if (locked) {
        debug('lock obtained - id: %s date: %s pid: %s', id, date, val)
        deferred = defer()
        // Persist invocation
        if (shouldPersistInvocations) {
          await redis.set(persistKey, scheduledTime, 'PX', persistScheduledMs)
        }
        // Run job
        await runFn(date)
        deferred.done()
      }
    }

    // Schedule last missed job if needed
    if (shouldPersistInvocations) {
      // Get previous invocation date
      const date = getPreviousDate(rule)
      const expectedLastRunTime = date.getTime()
      redis.get(persistKey).then((val) => {
        const lastRunTime = val ? Number.parseInt(val, 10) : 0
        // Last run time exists, but job was run prior to expected last run
        if (val && lastRunTime < expectedLastRunTime) {
          debug('missed job - id: %s date: %s', id, date)
          runJob(date)
        }
      })
    }
    // Schedule recurring job
    const schedule = nodeSchedule.scheduleJob(rule, runJob)
    // Handle shutdown gracefully
    const stop = () => {
      schedule.cancel()
      return deferred?.promise
    }
    stopFns.push(stop)

    return { schedule, stop }
  }

  /**
   * Schedule data to be delivered at a later date. Duplicate payloads
   * will be ignored.
   *
   * `scheduleFor` accepts a number of milliseconds in the future
   * or a date.
   *
   * Returns a boolean indicating if the item  was successfully scheduled.
   */
  const scheduleDelayed: Delayed = async (id, data, scheduleFor) => {
    const key = `delayed:${id}`
    const score =
      typeof scheduleFor === 'number'
        ? new Date().getTime() + scheduleFor
        : scheduleFor.getTime()
    const res = await redis.zadd(key, score, Buffer.from(data))
    return res === 1
  }

  /**
   * Check for delayed items according to the recurrence rule. Default
   * interval is every minute. Calls `runFn` for batch of items where
   * the delayed timestamp is <= now.
   *
   * Guarantees at least one delivery.
   */
  const runDelayed: RunDelayed = (id, runFn, opts = {}) => {
    const { rule = '* * * * *', lockExpireMs = ms('1m') } = opts
    const key = `delayed:${id}`
    let deferred: Deferred<void>

    const schedule = nodeSchedule.scheduleJob(rule, async (date) => {
      const scheduledTime = date.getTime()
      const lockKey = `${key}:${scheduledTime}`
      const val = process.pid
      // Attempt to get an exclusive lock. Lock expires in 1 minute.
      const locked = await redis.set(lockKey, val, 'PX', lockExpireMs, 'NX')
      if (locked) {
        debug('lock obtained - id: %s date: %s pid: %s', id, date, val)
        deferred = defer()
        const upper = new Date().getTime()
        // Get delayed items where the delayed timestamp is <= now
        const items = await redis.zrangebyscoreBuffer(key, '-inf', upper)
        if (items.length) {
          debug('delayed items found - id: %s num: %d', id, items.length)
          // Call run fn
          await runFn(id, items)
          // Remove delayed items
          await redis.zremrangebyscore(key, '-inf', upper)
        }
        deferred.done()
      }
    })

    const stop = () => {
      schedule.cancel()
      return deferred?.promise
    }
    stopFns.push(stop)

    return { schedule, stop }
  }

  /**
   * Call stop on all schedulers and close Redis connection
   */
  const stop = async () => {
    await Promise.all(stopFns.map((stop) => stop()))
    redis.disconnect()
  }

  return { scheduleRecurring, scheduleDelayed, runDelayed, stop }
}
