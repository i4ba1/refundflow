import type { WebhookRepository, RefundRepository } from '../repositories/interfaces.js'
import type { WebhookProvider } from '../providers/types.js'
import type { ProviderName } from '../schemas/refund.js'
import { logger } from '../utils/logger.js'
import type { ParsedWebhook } from '../providers/types.js'

export type WebhookProviderResolver = (name: ProviderName) => WebhookProvider

export interface WebhookContext {
  refundRepository: RefundRepository
}

export interface WebhookHandler {
  type: string
  handle(parsed: ParsedWebhook, ctx: WebhookContext): Promise<void>
}

export class WebhookService {
  private handlers = new Map<string, WebhookHandler>()

  constructor(
    private webhooks: WebhookRepository,
    private resolveProvider: WebhookProviderResolver,
    private refundRepository: RefundRepository,
  ) {
    for (const h of defaultHandlers()) this.register(h)
  }

  register(handler: WebhookHandler): void {
    this.handlers.set(handler.type, handler)
  }

  async handle(providerName: ProviderName, rawBody: string, signature: string) {
    const provider = this.resolveProvider(providerName)
    const parsed = await provider.parseWebhookEvent(rawBody, signature)

    const existing = await this.webhooks.findByExternalEventId(parsed.externalEventId)
    if (existing?.processed) {
      logger.info('webhook.duplicate', { externalEventId: parsed.externalEventId })
      return { status: 'already_processed' }
    }

    const event = await this.webhooks.create({
      provider: providerName,
      externalEventId: parsed.externalEventId,
      type: parsed.type,
      payload: parsed.payload,
    })

    const handler = this.handlers.get(parsed.type)
    const ctx: WebhookContext = { refundRepository: this.refundRepository }

    try {
      if (handler) await handler.handle(parsed, ctx)
      else logger.info('webhook.unhandled', { type: parsed.type })
      await this.webhooks.markProcessed(event.id)
      return { status: 'processed' }
    } catch (e) {
      logger.error('webhook.process.failed', { error: (e as Error).message })
      throw e
    }
  }
}

function defaultHandlers(): WebhookHandler[] {
  return [
    {
      type: 'refunds.succeeded',
      async handle(parsed, ctx) {
        const payload = parsed.payload as { data?: { object?: { id?: string } } }
        const providerRefId = payload.data?.object?.id
        if (!providerRefId) return
        const refund = await ctx.refundRepository.findByExternalRefundId(providerRefId)
        if (!refund) return
        await ctx.refundRepository.appendAudit({
          refundId: refund.id,
          action: 'SETTLE',
          fromStatus: refund.status,
          toStatus: 'SETTLED',
          actor: 'stripe-webhook',
        })
        await ctx.refundRepository.update(refund.id, { status: 'SETTLED' })
        logger.info('webhook.refund.settled', { providerRefId })
      },
    },
  ]
}