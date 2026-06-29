import {
  retry,
  circuitBreaker,
  timeout,
  fallback,
  wrap,
  handleWhen,
  isBrokenCircuitError,
  isTaskCancelledError,
  ExponentialBackoff,
  ConsecutiveBreaker,
  CircuitState,
  TimeoutStrategy,
} from 'cockatiel'
import { logger } from '../utils/logger.js'

export const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504])

const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
])

function reasonString(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return String(reason)
  const r = reason as { error?: Error; value?: unknown; isolated?: true }
  if (r.isolated) return 'circuit_isolated'
  if (r.error) return r.error.message
  if ('value' in r) return String(r.value)
  return JSON.stringify(r)
}

export function isRetryableStripeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: string; statusCode?: number; type?: string }

  if (typeof e.code === 'string' && TRANSIENT_NODE_ERROR_CODES.has(e.code)) return true
  if (e.name === 'StripeConnectionError' || e.name === 'StripeAPIError') {
    if (e.name === 'StripeAPIError') {
      return typeof e.statusCode === 'number' && RETRYABLE_HTTP_STATUS.has(e.statusCode)
    }
    return true
  }
  if (e.type === 'StripeConnectionError') return true
  if (typeof e.statusCode === 'number' && RETRYABLE_HTTP_STATUS.has(e.statusCode)) return true

  return false
}

function isRetryableByPredicate(err: unknown): boolean {
  if (isBrokenCircuitError(err)) return true
  if (isTaskCancelledError(err)) return true
  return isRetryableStripeError(err)
}

const stripeRetryPolicy = retry(
  handleWhen(isRetryableByPredicate),
  {
    maxAttempts: 2,
    backoff: new ExponentialBackoff({
      initialDelay: 200,
      maxDelay: 2_000,
      exponent: 2,
    }),
  },
)

stripeRetryPolicy.onRetry((event) => {
  logger.warn('resilience.retry', {
    policy: 'stripe',
    attempt: event.attempt + 1,
    delay: event.delay,
    reason: reasonString(event),
  })
})
stripeRetryPolicy.onGiveUp((event) => {
  logger.error('resilience.retry.exhausted', { policy: 'stripe', reason: reasonString(event) })
})

const stripeBreaker = circuitBreaker(handleWhen(isRetryableByPredicate), {
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(5),
})
stripeBreaker.onBreak((reason) => {
  logger.error('resilience.circuit.open', { policy: 'stripe', reason: reasonString(reason) })
})
stripeBreaker.onReset(() => {
  logger.info('resilience.circuit.close', { policy: 'stripe' })
})
stripeBreaker.onHalfOpen(() => {
  logger.warn('resilience.circuit.halfopen', { policy: 'stripe' })
})

const stripeTimeout = timeout(8_000, { strategy: TimeoutStrategy.Aggressive, abortOnReturn: true })
stripeTimeout.onTimeout(() => {
  logger.error('resilience.timeout', { policy: 'stripe', durationMs: 8_000 })
})

export const stripePolicy = wrap(stripeRetryPolicy, stripeBreaker, stripeTimeout)

const openaiRetryPolicy = retry(handleWhen(isRetryableByPredicate), {
  maxAttempts: 1,
  backoff: new ExponentialBackoff({
    initialDelay: 500,
    maxDelay: 1_500,
    exponent: 2,
  }),
})
openaiRetryPolicy.onRetry((event) => {
  logger.warn('resilience.retry', {
    policy: 'openai',
    attempt: event.attempt + 1,
    delay: event.delay,
    reason: reasonString(event),
  })
})
openaiRetryPolicy.onGiveUp((event) => {
  logger.error('resilience.retry.exhausted', { policy: 'openai', reason: reasonString(event) })
})

const openaiBreaker = circuitBreaker(handleWhen(isRetryableByPredicate), {
  halfOpenAfter: 60_000,
  breaker: new ConsecutiveBreaker(10),
})
openaiBreaker.onBreak((reason) => {
  logger.error('resilience.circuit.open', { policy: 'openai', reason: reasonString(reason) })
})
openaiBreaker.onReset(() => {
  logger.info('resilience.circuit.close', { policy: 'openai' })
})
openaiBreaker.onHalfOpen(() => {
  logger.warn('resilience.circuit.halfopen', { policy: 'openai' })
})

const openaiTimeout = timeout(15_000, { strategy: TimeoutStrategy.Aggressive, abortOnReturn: true })
openaiTimeout.onTimeout(() => {
  logger.error('resilience.timeout', { policy: 'openai', durationMs: 15_000 })
})

export function withOpenAIPolicy<T>(fn: () => Promise<T>, fallbackValue: T): Promise<T> {
  const fb = fallback(handleWhen(() => true), () => fallbackValue)
  return wrap(fb, openaiRetryPolicy, openaiBreaker, openaiTimeout).execute(fn) as Promise<T>
}

export const webhookTimeout = timeout(5_000, { strategy: TimeoutStrategy.Aggressive, abortOnReturn: true })

export function isRetryableError(err: unknown): boolean {
  return isRetryableByPredicate(err)
}

export function getStripeBreakerState(): CircuitState {
  return stripeBreaker.state
}

export function getOpenAIBreakerState(): CircuitState {
  return openaiBreaker.state
}
