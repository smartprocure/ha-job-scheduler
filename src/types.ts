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
export type StopFn = () => Promise<void>
export type GracefulShutdown = { schedule: Job; stop: StopFn }

export interface RecurringOptions {
  lockExpireMs?: number
  persistScheduledMs?: number
}

export type Rule = string | { rule: string; tz: string }
export type RunFn = (date: Date) => Promise<void> | void

export type Recurring = (
  id: string,
  rule: Rule,
  runFn: RunFn,
  options?: RecurringOptions
) => GracefulShutdown

export interface DelayedOptions {
  rule?: Rule
  lockExpireMs?: number
}

export type RunDelayed = (
  id: string,
  runFn: DelayedFn,
  options?: DelayedOptions
) => GracefulShutdown
