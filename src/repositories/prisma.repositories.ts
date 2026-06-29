import { PrismaClient, Prisma } from '@prisma/client'
import type { RefundRepository, OrderRepository, WebhookRepository, RefundWithOrder } from './interfaces.js'
import type { RefundStatus, RefundReason, ProviderName } from '../schemas/refund.js'

export class PrismaRefundRepository implements RefundRepository {
  constructor(private prisma: PrismaClient) {}

  async findById(id: string): Promise<RefundWithOrder | null> {
    return this.prisma.refund.findUnique({ where: { id }, include: { order: true } })
  }

  async findByIdempotencyKey(key: string): Promise<RefundWithOrder | null> {
    return this.prisma.refund.findUnique({ where: { idempotencyKey: key }, include: { order: true } })
  }

  async list(limit: number, offset: number) {
    const [items, total] = await Promise.all([
      this.prisma.refund.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: { order: true },
      }),
      this.prisma.refund.count(),
    ])
    return { items, total }
  }

  async create(data: {
    orderId: string
    amount: number
    currency: string
    reason: RefundReason
    status: RefundStatus
    provider: ProviderName
    idempotencyKey: string
  }): Promise<RefundWithOrder> {
    return this.prisma.refund.create({
      data: data as Prisma.RefundUncheckedCreateInput,
      include: { order: true },
    })
  }

  async update(id: string, data: Partial<{
    status: RefundStatus
    providerRefId: string
    externalRefundId: string
    agentDecision: string
    agentRationale: unknown
    reviewedAt: Date
  }>): Promise<RefundWithOrder> {
    return this.prisma.refund.update({
      where: { id },
      data: data as Prisma.RefundUncheckedUpdateInput,
      include: { order: true },
    })
  }

  async appendAudit(data: {
    refundId: string
    action: string
    fromStatus: RefundStatus | null
    toStatus: RefundStatus
    actor: string
    metadata?: unknown
  }): Promise<void> {
    await this.prisma.refundAudit.create({
      data: {
        refundId: data.refundId,
        action: data.action,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        actor: data.actor,
        metadata: data.metadata as Prisma.InputJsonValue | undefined,
      },
    })
  }

  async findByExternalRefundId(externalRefundId: string): Promise<RefundWithOrder | null> {
    return this.prisma.refund.findUnique({
      where: { externalRefundId },
      include: { order: true },
    })
  }

  async findByProviderRefId(providerRefId: string): Promise<RefundWithOrder | null> {
    return this.prisma.refund.findFirst({
      where: { providerRefId },
      include: { order: true },
    })
  }

  async countForCustomer(email: string): Promise<number> {
    return this.prisma.refund.count({
      where: { order: { customerEmail: email }, status: { in: ['SETTLED', 'APPROVED'] } },
    })
  }
}

export class PrismaOrderRepository implements OrderRepository {
  constructor(private prisma: PrismaClient) {}

  async findById(id: string) {
    return this.prisma.order.findUnique({ where: { id } })
  }
}

export class PrismaWebhookRepository implements WebhookRepository {
  constructor(private prisma: PrismaClient) {}

  async findByExternalEventId(externalEventId: string) {
    return this.prisma.webhookEvent.findUnique({
      where: { externalEventId },
      select: { id: true, processed: true },
    })
  }

  async create(data: { provider: ProviderName; externalEventId: string; type: string; payload: unknown }) {
    const created = await this.prisma.webhookEvent.create({
      data: {
        provider: data.provider,
        externalEventId: data.externalEventId,
        type: data.type,
        payload: data.payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    return { id: created.id }
  }

  async markProcessed(id: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { processed: true, processedAt: new Date() },
    })
  }
}