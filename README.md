# HA Job Scheduler

Highly available cron job scheduling using [node-schedule](https://www.npmjs.com/package/node-schedule)
and [Redis](https://redis.com/).

Designed to be used in an environment with redundant schedulers. Only one scheduler
will ever successfully run the cron job.

Previously missed invocations can be run by passing a non-zero value for
`persistScheduledMs` to `scheduleRecurring`. This will persist invocations
to Redis which can be also useful for debugging.

Works well with [nats-jobs](https://www.npmjs.com/package/nats-jobs)

## scheduleRecurring

```typescript
scheduleRecurring(
  id: string,
  rule: Rule,
  runFn: RunFn,
  options?: RecurringOptions
) => GracefulShutdown
```

Schedule a recurring job. `runFn` will be called for every invocation of the rule.

Set `persistScheduledMs` to a value greater than the frequency of the cron
rule to guarantee that the last missed job will be run. This is useful for
infrequent jobs that cannot be missed. For example, if you have a job that runs
at 6am daily, you might want to set `persistScheduledMs` to `ms('25h')` so that
a missed run will be attempted up to one hour past the scheduled invocation.

Guarantees at most one delivery.

```typescript
import { jobScheduler } from 'ha-job-scheduler'
import ms from 'ms'

const scheduler = jobScheduler()
const runFn = (date: Date) => {
  console.log(date)
}
const { stop } = scheduler.scheduleRecurring(
  'everyMinute',
  '* * * * *',
  runFn,
  { persistScheduledMs: ms('1h') }
)
// Gracefully handle signals
const shutDown = async () => {
  await stop()
  process.exit(0)
}
process.on('SIGTERM', shutDown)
process.on('SIGINT', shutDown)
```

## scheduleDelayed

Schedule data to be delivered at a later date. Duplicate payloads
will be ignored. `scheduleFor` accepts a number of milliseconds
in the future or a date. Use in conjunction with `runDelayed`.

Returns a boolean indicating if the item  was successfully scheduled.

```typescript
scheduleDelayed(
  id: string,
  data: Uint8Array,
  scheduleFor: number | Date
) => Promise<boolean>
```

```typescript
// Schedule for the future
for (let i = 1; i <= 3; i++) {
  await scheduler.scheduleDelayed(
    'orders',
    `delayed data ${i}`,
    ms(`${i * 10}s`)
  )
}
```

## runDelayed

Check for delayed items according to the recurrence rule. Default
interval is every minute. Calls `runFn` for the batch of items where
the delayed timestamp is <= now. The default number of items to
retrieve at one time is 100.

The `id` parameter should match the `id` passed to `scheduleDelayed`. 

Guarantees at least one delivery.

```typescript
runDelayed(
  id: string,
  runFn: DelayedFn,
  options?: DelayedOptions
) => GracefulShutdown
```

```typescript
// Do something with scheduled jobs
scheduler.runDelayed('orders', async (values) => {
  console.log('Running delayed for', values)
})
```
