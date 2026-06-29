import type { ProviderName } from '../schemas/refund.js'

export interface ProviderRefundResult {
  providerRefId: string
  status: 'succeeded' | 'pending' | 'failed'
  raw: unknown
}

export interface ProviderRefundInput {
  externalPaymentId: string
  amount: number
  currency: string
  reason: string
  idempotencyKey: string
}

export interface ParsedWebhook {
  externalEventId: string
  type: string
  payload: unknown
}

export interface RefundProvider {
  name: ProviderName
  createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult>
}

export interface WebhookProvider {
  name: ProviderName
  parseWebhookEvent(rawBody: string, signature: string): Promise<ParsedWebhook>
}