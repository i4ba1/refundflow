import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CircuitState } from 'cockatiel'

function makeStripeError(statusCode: number, name = 'StripeAPIError') {
  const err = new Error(`stripe ${statusCode}`) as Error & { name: string; statusCode: number }
  err.name = name
  err.statusCode = statusCode
  return err
}

function makeNodeError(code: string) {
  const err = new Error(`node ${code}`) as Error & { code: string }
  err.code = code
  return err
}

let isRetryableStripeError: typeof import('../src/lib/resilience')['isRetryableStripeError']
let RETRYABLE_HTTP_STATUS: typeof import('../src/lib/resilience')['RETRYABLE_HTTP_STATUS']
let stripePolicy: typeof import('../src/lib/resilience')['stripePolicy']
let withOpenAIPolicy: typeof import('../src/lib/resilience')['withOpenAIPolicy']
let getStripeBreakerState: typeof import('../src/lib/resilience')['getStripeBreakerState']
let getOpenAIBreakerState: typeof import('../src/lib/resilience')['getOpenAIBreakerState']

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  const mod = await import('../src/lib/resilience')
  isRetryableStripeError = mod.isRetryableStripeError
  RETRYABLE_HTTP_STATUS = mod.RETRYABLE_HTTP_STATUS
  stripePolicy = mod.stripePolicy
  withOpenAIPolicy = mod.withOpenAIPolicy
  getStripeBreakerState = mod.getStripeBreakerState
  getOpenAIBreakerState = mod.getOpenAIBreakerState
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isRetryableStripeError', () => {
  it('retries 5xx HTTP statuses', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isRetryableStripeError(makeStripeError(s))).toBe(true)
    }
  })

  it('retries 408 and 429', () => {
    expect(isRetryableStripeError(makeStripeError(408))).toBe(true)
    expect(isRetryableStripeError(makeStripeError(429))).toBe(true)
  })

  it('does not retry 4xx other than 408/429', () => {
    expect(isRetryableStripeError(makeStripeError(400))).toBe(false)
    expect(isRetryableStripeError(makeStripeError(401))).toBe(false)
    expect(isRetryableStripeError(makeStripeError(403))).toBe(false)
    expect(isRetryableStripeError(makeStripeError(404))).toBe(false)
  })

  it('retries StripeConnectionError regardless of statusCode', () => {
    expect(isRetryableStripeError(makeStripeError(0, 'StripeConnectionError'))).toBe(true)
  })

  it('retries transient node errors', () => {
    for (const c of ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED']) {
      expect(isRetryableStripeError(makeNodeError(c))).toBe(true)
    }
  })

  it('does not retry random Error instances', () => {
    expect(isRetryableStripeError(new Error('boom'))).toBe(false)
    expect(isRetryableStripeError(null)).toBe(false)
    expect(isRetryableStripeError('boom')).toBe(false)
  })

  it('exposes the documented status set', () => {
    expect(RETRYABLE_HTTP_STATUS.has(500)).toBe(true)
    expect(RETRYABLE_HTTP_STATUS.has(400)).toBe(false)
  })
})

describe('stripePolicy retry + backoff', () => {
  it('succeeds on the first attempt when the function resolves', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const p = stripePolicy.execute(fn) as Promise<string>
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable errors and eventually succeeds (1 initial + 2 retries = 3 calls)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeStripeError(503))
      .mockRejectedValueOnce(makeStripeError(500))
      .mockResolvedValueOnce('ok')

    const p = stripePolicy.execute(fn) as Promise<string>
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(makeStripeError(400))
    const p = stripePolicy.execute(fn) as Promise<string>
    const assertion = expect(p).rejects.toThrow(/stripe 400/)
    await vi.runAllTimersAsync()
    await assertion
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('withOpenAIPolicy (retry + circuit + timeout + fallback)', () => {
  it('returns function result on success without falling back', async () => {
    const fn = vi.fn().mockResolvedValue({ decision: 'APPROVE' })
    const p = withOpenAIPolicy(fn, { decision: 'NEEDS_HUMAN' })
    await vi.runAllTimersAsync()
    await expect(p).resolves.toEqual({ decision: 'APPROVE' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries retryable errors and returns the value on success (1 initial + 1 retry = 2 calls)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeStripeError(503))
      .mockResolvedValueOnce({ decision: 'REJECT' })
    const p = withOpenAIPolicy(fn, { decision: 'NEEDS_HUMAN' })
    await vi.runAllTimersAsync()
    await expect(p).resolves.toEqual({ decision: 'REJECT' })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('falls back to NEEDS_HUMAN when retries are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(makeStripeError(503))
    const fallbackValue = {
      decision: 'NEEDS_HUMAN' as const,
      confidence: 0,
      rationale: 'agent_unavailable',
      signals: [],
    }
    const p = withOpenAIPolicy(fn, fallbackValue)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toEqual(fallbackValue)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('falls back immediately on a non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad input'))
    const p = withOpenAIPolicy(fn, { sentinel: 'fallback' })
    await vi.runAllTimersAsync()
    await expect(p).resolves.toEqual({ sentinel: 'fallback' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('circuit breaker state inspection', () => {
  it('reports the current Stripe circuit state (Closed at module load)', () => {
    expect(typeof getStripeBreakerState()).toBe('number')
    expect([CircuitState.Closed, CircuitState.Open, CircuitState.HalfOpen, CircuitState.Isolated]).toContain(
      getStripeBreakerState(),
    )
  })

  it('reports the current OpenAI circuit state (Closed at module load)', () => {
    expect(typeof getOpenAIBreakerState()).toBe('number')
  })
})
