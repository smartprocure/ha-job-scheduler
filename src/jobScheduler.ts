import nodeSchedule from 'node-schedule'
import Redis from 'ioredis'
import ms from 'ms'
import _debug from 'debug'
import { PubDelayed, Deferred, Delayed, Recurring } from './types'
import { defer } from './util'
import parser from 'cron-parser'
import { RedisOptions } from 'ioredis'

const debug = _debug('ha-job-scheduler')

export const jobScheduler = (opts?: RedisOptions) => {
  const redis = opts ? new Redis(opts) : new Redis()

  /**
   * Schedule a recurring job. fn will be called for every invocation of the rule.
   *
   * See: https://www.npmjs.com/package/node-schedule
   *
   * Guarantees at most one delivery.
   */
  const scheduleRecurring: Recurring = (id, rule, fn, options) => {
    const { lockExpireMs = ms('1m'), persistScheduledMs = ms('5m') } = options
    let deferred: Deferred<void>
    // Should invocations be persisted to Redis
    const shouldPersistInvocations =
      typeof persistScheduledMs === 'number' && persistScheduledMs > 0
    const getPersistKey = (scheduledTime: number) =>
      `jobRun:${id}:${scheduledTime}`
    // Called for each invocation
    const run = async (date: Date) => {
      const scheduledTime = date.getTime()
      const lockKey = `schedulingLock:${id}:${scheduledTime}`
      const persistKey = getPersistKey(scheduledTime)
      // That process that obtained the lock
      const val = process.pid
      // Attempt to get an exclusive lock. Lock expires in 1 minute.
      const lockObtained = await redis.set(
        lockKey,
        val,
        'PX',
        lockExpireMs,
        'NX'
      )
      // Lock was obtained
      if (lockObtained) {
        debug('lock obtained: %s (%s)', id, date)
        deferred = defer()
        // Persist invocation
        if (shouldPersistInvocations) {
          await redis.set(persistKey, val, 'PX', persistScheduledMs)
        }
        // Run job
        await fn(date)
        debug('job run: %s (%s)', id, date)
        deferred.done()
      }
    }
    // Schedule last missed job if needed
    if (shouldPersistInvocations) {
      const interval = parser.parseExpression(rule)
      const date = interval.prev()
      redis.exists(getPersistKey(date.getTime())).then((x) => {
        if (!x) {
          debug('missed job: %s (%s)', id, date)
          run(date.toDate())
        }
      })
    }
    // Schedule recurring job
    const schedule = nodeSchedule.scheduleJob(rule, run)
    // Handle shutdown gracefully
    const stop = () => {
      debug('stopping recurring: %s', id)
      schedule.cancel()
      return deferred?.promise
    }
    return { schedule, stop }
  }

  /**
   * Schedule a single job to be published at a later date.
   *
   * scheduleFor accepts a number of milliseconds in the future
   * or a date.
   *
   * Returns a boolean indicating if the job was successfully scheduled.
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
   * Publish delayed one-time jobs for id. Check for jobs
   * according to the recurrence rule. Default interval is every 10 seconds.
   *
   * Guarantees at least one delivery.
   */
  const publishDelayed: PubDelayed = (id, fn, rule) => {
    rule = rule ?? '*/10 * * * * *'
    const key = `delayed:${id}`
    let deferred: Deferred<void>

    const schedule = nodeSchedule.scheduleJob(rule, async (date) => {
      const scheduledTime = date.getTime()
      const lockKey = `${key}:${scheduledTime}`
      const val = process.pid
      // Attempt to get an exclusive lock. Lock expires in 1 minute.
      const lockObtained = await redis.set(lockKey, val, 'PX', ms('1m'), 'NX')
      if (lockObtained) {
        deferred = defer()
        debug('delayed: %s', date)
        const upper = new Date().getTime()
        // Get delayed jobs where the delayed timestamp is <= now
        const items = await redis.zrangebyscoreBuffer(key, '-inf', upper)
        if (items.length) {
          debug('delayed jobs found: %d', items.length)
          // Call fn for each message
          await Promise.all(items.map((data) => fn(id, data)))
          // Remove delayed jobs
          await redis.zremrangebyscore(key, '-inf', upper)
        }
        deferred.done()
      }
    })

    const stop = () => {
      schedule.cancel()
      return deferred?.promise
    }
    return { schedule, stop }
  }

  return { scheduleRecurring, scheduleDelayed, publishDelayed }
}
