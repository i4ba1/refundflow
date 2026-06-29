import Stripe from 'stripe'
import type { RefundProvider, WebhookProvider, ProviderRefundInput, ProviderRefundResult, ParsedWebhook } from './types.js'
import { ProviderError } from '../lib/errors.js'
import { logger } from '../utils/logger.js'
import { stripePolicy, webhookTimeout } from '../lib/resilience.js'

export class StripeProvider implements RefundProvider, WebhookProvider {
  name = 'STRIPE' as const
  private client: Stripe

  constructor(secretKey: string, private webhookSecret: string) {
    this.client = new Stripe(secretKey, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      timeout: 8_000,
    })
  }

  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    try {
      const refund = await stripePolicy.execute(() =>
        this.client.refunds.create(
          {
            payment_intent: input.externalPaymentId,
            amount: Math.round(input.amount * 100),
            currency: input.currency.toLowerCase(),
            reason: this.mapReason(input.reason),
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      )
      return {
        providerRefId: refund.id,
        status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
        raw: refund,
      }
    } catch (e) {
      logger.error('stripe.refund.failed', { error: (e as Error).message })
      throw new ProviderError('STRIPE', (e as Error).message)
    }
  }

  private mapReason(reason: string): Stripe.RefundCreateParams.Reason {
    switch (reason) {
      case 'FRAUDULENT':
        return 'fraudulent'
      case 'DUPLICATE':
        return 'duplicate'
      default:
        return 'requested_by_customer'
    }
  }

  async parseWebhookEvent(rawBody: string, signature: string): Promise<ParsedWebhook> {
    try {
      const event = await webhookTimeout.execute(() =>
        Promise.resolve(this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret)),
      )
      return { externalEventId: event.id, type: event.type, payload: event }
    } catch (e) {
      throw new ProviderError('STRIPE', `webhook verification failed: ${(e as Error).message}`)
    }
  }
}