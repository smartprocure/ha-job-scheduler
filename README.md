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
infrequent jobs that cannot be missed.

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
