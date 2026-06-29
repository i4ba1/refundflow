import type { RefundRepository, OrderRepository, RefundWithOrder } from '../repositories/interfaces.js'
import type { AgentReviewer } from '../ai/types.js'
import type { RefundProvider } from '../providers/types.js'
import type { ProviderName } from '../schemas/refund.js'
import { transition, shouldTriggerReview } from '../machines/refund.machine.js'
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js'
import { logger } from '../utils/logger.js'
import type { CreateRefundInput, RefundStatus } from '../schemas/refund.js'
import type { AgentReviewResult } from '../ai/types.js'

export type RefundProviderResolver = (name: ProviderName) => RefundProvider

export class RefundService {
  constructor(
    private refunds: RefundRepository,
    private orders: OrderRepository,
    private agent: AgentReviewer,
    private resolveProvider: RefundProviderResolver,
  ) {}

  async createRefund(input: CreateRefundInput): Promise<RefundWithOrder> {
    const order = await this.orders.findById(input.orderId)
    if (!order) throw new NotFoundError('Order', input.orderId)

    if (order.provider !== input.provider) {
      throw new ValidationError('Order provider does not match refund provider')
    }

    const existing = await this.refunds.findByIdempotencyKey(input.idempotencyKey)
    if (existing) throw new ConflictError('Idempotency key already used')

    if (input.amount > Number(order.amount)) {
      throw new ValidationError('Refund amount exceeds order amount')
    }

    const needsReview = shouldTriggerReview(input.amount, input.reason)

    return this.refunds.create({
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      reason: input.reason,
      status: needsReview ? 'UNDER_REVIEW' : 'PENDING',
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
    })
  }

  async getRefund(id: string): Promise<RefundWithOrder> {
    const refund = await this.refunds.findById(id)
    if (!refund) throw new NotFoundError('Refund', id)
    return refund
  }

  async listRefunds(limit = 20, offset = 0) {
    return this.refunds.list(limit, offset)
  }

  async triggerReview(refundId: string): Promise<RefundWithOrder> {
    const refund = await this.getRefund(refundId)
    if (refund.status !== 'UNDER_REVIEW') {
      throw new ValidationError('Refund is not in UNDER_REVIEW state')
    }

    const result = await this.agent.reviewRefund(refundId)
    logger.info('refund.review.completed', { refundId, decision: result.decision })

    const event = mapAgentDecisionToEvent(result)
    const newStatus = transition(refund.status, event)

    return this.refunds.update(refundId, {
      status: newStatus,
      agentDecision: result.decision,
      agentRationale: result,
      reviewedAt: new Date(),
    })
  }

  async settleRefund(refundId: string): Promise<RefundWithOrder> {
    const refund = await this.getRefund(refundId)
    const newStatus = transition(refund.status, 'SETTLE')

    const provider = this.resolveProvider(refund.provider)
    let result: { providerRefId: string; status: 'succeeded' | 'pending' | 'failed' }

    try {
      result = await provider.createRefund({
        externalPaymentId: refund.order.externalId,
        amount: Number(refund.amount),
        currency: refund.currency,
        reason: refund.reason,
        idempotencyKey: refund.idempotencyKey,
      })
    } catch (e) {
      const existing = await this.refunds.findByProviderRefId(refund.idempotencyKey)
      if (existing && existing.status === 'SETTLED') {
        logger.warn('refund.settle.reconciled', {
          refundId,
          providerRefId: existing.providerRefId,
        })
        return existing
      }
      throw e
    }

    const existingByRef = await this.refunds.findByProviderRefId(result.providerRefId)
    if (existingByRef && existingByRef.id !== refundId && existingByRef.status === 'SETTLED') {
      logger.warn('refund.settle.reconciled.existing', {
        refundId,
        providerRefId: result.providerRefId,
        existingRefundId: existingByRef.id,
      })
      await this.refunds.update(refundId, {
        status: 'SETTLED',
        providerRefId: result.providerRefId,
        externalRefundId: result.providerRefId,
      })
      return this.getRefund(refundId)
    }

    const finalStatus: RefundStatus =
      result.status === 'failed' ? transition(newStatus, 'FAIL') : newStatus

    return this.refunds.update(refundId, {
      status: finalStatus,
      providerRefId: result.providerRefId,
      externalRefundId: result.providerRefId,
    })
  }

  async approveRefund(refundId: string, actor = 'admin'): Promise<RefundWithOrder> {
    return this.applyTransition(refundId, 'APPROVE', actor)
  }

  async rejectRefund(refundId: string, actor = 'admin'): Promise<RefundWithOrder> {
    return this.applyTransition(refundId, 'REJECT', actor)
  }

  private async applyTransition(
    refundId: string,
    event: 'APPROVE' | 'REJECT',
    actor: string,
  ): Promise<RefundWithOrder> {
    const refund = await this.getRefund(refundId)
    const newStatus = transition(refund.status, event)
    const updated = await this.refunds.update(refundId, { status: newStatus })
    await this.refunds.appendAudit({
      refundId,
      action: event,
      fromStatus: refund.status,
      toStatus: newStatus,
      actor,
    })
    return updated
  }
}

function mapAgentDecisionToEvent(result: AgentReviewResult): 'APPROVE' | 'REJECT' {
  if (result.decision === 'APPROVE') return 'APPROVE'
  return 'REJECT'
}