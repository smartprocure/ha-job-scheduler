import parser from 'cron-parser'
import { Rule, Deferred } from './types'

export function defer<A>(): Deferred<A> {
  // eslint-disable-next-line
  let done = (value: A) => {}
  const promise = new Promise<A>((res) => {
    done = res
  })
  return {
    done,
    promise,
  }
}

/**
 * Get the previous invocation date based on the rule
 */
export const getPreviousDate = (rule: Rule) => {
  const isString = typeof rule === 'string'
  // Parse rule
  const interval = isString
    ? parser.parseExpression(rule)
    : parser.parseExpression(rule.rule, { tz: rule.tz })
  // Previous date
  return interval.prev().toDate()
}
