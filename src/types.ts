import { Job } from 'node-schedule'

export type Delayed = (
  id: string,
  data: Uint8Array,
  scheduleFor: number | Date
) => Promise<boolean>

export interface Deferred<A> {
  done: (value: A) => void
  promise: Promise<A>
}

export type DelayedFn = (id: string, data: Uint8Array) => Promise<void> | void

export type GracefulShutdown = { schedule: Job; stop: () => Promise<void> }

export interface RecurringOptions {
  lockExpireMs?: number
  persistScheduledMs?: number
}

export type Rule = string
export type RunFn = (date: Date) => Promise<void> | void

export type Recurring = (
  id: string,
  rule: Rule,
  fn: RunFn,
  options: RecurringOptions
) => GracefulShutdown

export type PubDelayed = (
  id: string,
  fn: DelayedFn,
  rule?: Rule
) => GracefulShutdown
