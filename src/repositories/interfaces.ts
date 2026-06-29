import type { Prisma } from '@prisma/client'
import type { RefundStatus, RefundReason, ProviderName } from '../schemas/refund.js'

export type RefundWithOrder = Prisma.RefundGetPayload<{ include: { order: true } }>

export interface RefundRepository {
  findById(id: string): Promise<RefundWithOrder | null>
  findByIdempotencyKey(key: string): Promise<RefundWithOrder | null>
  list(limit: number, offset: number): Promise<{ items: RefundWithOrder[]; total: number }>
  create(data: {
    orderId: string
    amount: number
    currency: string
    reason: RefundReason
    status: RefundStatus
    provider: ProviderName
    idempotencyKey: string
  }): Promise<RefundWithOrder>
  update(
    id: string,
    data: Partial<{
      status: RefundStatus
      providerRefId: string
      externalRefundId: string
      agentDecision: string
      agentRationale: unknown
      reviewedAt: Date
    }>,
  ): Promise<RefundWithOrder>
  appendAudit(data: {
    refundId: string
    action: string
    fromStatus: RefundStatus | null
    toStatus: RefundStatus
    actor: string
    metadata?: unknown
  }): Promise<void>
  findByExternalRefundId(externalRefundId: string): Promise<RefundWithOrder | null>
  findByProviderRefId(providerRefId: string): Promise<RefundWithOrder | null>
  countForCustomer(email: string): Promise<number>
}

export interface OrderRepository {
  findById(id: string): Promise<{
    id: string
    externalId: string
    provider: ProviderName
    amount: Prisma.Decimal
    currency: string
    customerEmail: string
    customerName: string | null
    createdAt: Date
  } | null>
}

export interface WebhookRepository {
  findByExternalEventId(externalEventId: string): Promise<{ id: string; processed: boolean } | null>
  create(data: {
    provider: ProviderName
    externalEventId: string
    type: string
    payload: unknown
  }): Promise<{ id: string }>
  markProcessed(id: string): Promise<void>
}