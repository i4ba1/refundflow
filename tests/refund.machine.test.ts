import { describe, it, expect } from 'vitest'
import {
  transition,
  canTransition,
  nextStatus,
  InvalidTransitionError,
  shouldTriggerReview,
  REFUND_RULES,
} from '../src/machines/refund.machine'

describe('refund state machine', () => {
  it('transitions PENDING -> UNDER_REVIEW on SUBMIT_REVIEW', () => {
    expect(transition('PENDING', 'SUBMIT_REVIEW')).toBe('UNDER_REVIEW')
  })

  it('transitions UNDER_REVIEW -> APPROVED on APPROVE', () => {
    expect(transition('UNDER_REVIEW', 'APPROVE')).toBe('APPROVED')
  })

  it('transitions APPROVED -> SETTLED on SETTLE', () => {
    expect(transition('APPROVED', 'SETTLE')).toBe('SETTLED')
  })

  it('rejects invalid transition SETTLED -> APPROVED', () => {
    expect(() => transition('SETTLED', 'APPROVE')).toThrow(InvalidTransitionError)
  })

  it('canTransition returns false for invalid', () => {
    expect(canTransition('FAILED', 'SETTLE')).toBe(false)
  })

  it('nextStatus returns undefined for invalid', () => {
    expect(nextStatus('REJECTED', 'APPROVE')).toBeUndefined()
  })

  it('FAILED is terminal (no transitions out)', () => {
    expect(canTransition('FAILED', 'APPROVE')).toBe(false)
  })
})

describe('review rules', () => {
  it('triggers review when amount >= threshold', () => {
    expect(shouldTriggerReview(REFUND_RULES.highValueThreshold, 'CUSTOMER_REQUEST')).toBe(true)
  })

  it('triggers review for fraud reason regardless of amount', () => {
    expect(shouldTriggerReview(1, 'FRAUDULENT')).toBe(true)
  })

  it('does not trigger review for low-value non-fraud', () => {
    expect(shouldTriggerReview(10, 'CUSTOMER_REQUEST')).toBe(false)
  })
})