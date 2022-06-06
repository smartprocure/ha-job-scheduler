# HA Job Scheduler

Highly available cron job scheduling using [node-schedule](https://www.npmjs.com/package/node-schedule)
and [Redis](https://redis.com/).

Designed to be used in an environment with redundant schedulers. Only one scheduler
will ever successfully run the cron job.

Previously missed invocation can be run by passing a non-zero value for
`persistScheduledMs` to `scheduleRecurring`. This will persist invocations
to Redis which can be also useful for debugging.
