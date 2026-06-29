export type RefundStatus =
  | 'PENDING'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'SETTLED'
  | 'FAILED'

export type RefundEvent =
  | 'SUBMIT_REVIEW'
  | 'APPROVE'
  | 'REJECT'
  | 'SETTLE'
  | 'FAIL'

type Transition = { from: RefundStatus; event: RefundEvent; to: RefundStatus }

const TRANSITIONS: Transition[] = [
  { from: 'PENDING', event: 'SUBMIT_REVIEW', to: 'UNDER_REVIEW' },
  { from: 'PENDING', event: 'APPROVE', to: 'APPROVED' },
  { from: 'PENDING', event: 'REJECT', to: 'REJECTED' },
  { from: 'PENDING', event: 'FAIL', to: 'FAILED' },
  { from: 'UNDER_REVIEW', event: 'APPROVE', to: 'APPROVED' },
  { from: 'UNDER_REVIEW', event: 'REJECT', to: 'REJECTED' },
  { from: 'UNDER_REVIEW', event: 'FAIL', to: 'FAILED' },
  { from: 'APPROVED', event: 'SETTLE', to: 'SETTLED' },
  { from: 'APPROVED', event: 'FAIL', to: 'FAILED' },
]

export function nextStatus(
  current: RefundStatus,
  event: RefundEvent,
): RefundStatus | undefined {
  return TRANSITIONS.find((t) => t.from === current && t.event === event)?.to
}

export function canTransition(
  current: RefundStatus,
  event: RefundEvent,
): boolean {
  return TRANSITIONS.some((t) => t.from === current && t.event === event)
}

export class InvalidTransitionError extends Error {
  constructor(
    public current: RefundStatus,
    public event: RefundEvent,
  ) {
    super(`No transition from ${current} on event ${event}`)
    this.name = 'InvalidTransitionError'
  }
}

export function transition(current: RefundStatus, event: RefundEvent): RefundStatus {
  const target = nextStatus(current, event)
  if (!target) throw new InvalidTransitionError(current, event)
  return target
}

export const REFUND_RULES = {
  highValueThreshold: 500,
  fraudReason: 'FRAUDULENT' as const,
  // refunds > threshold OR reason=FRAUDULENT require agent review
  requiresReview(amount: number, reason: string): boolean {
    return amount >= this.highValueThreshold || reason === this.fraudReason
  },
}

export function shouldTriggerReview(amount: number, reason: string): boolean {
  return REFUND_RULES.requiresReview(amount, reason)
}