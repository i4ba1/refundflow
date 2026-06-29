import type { RefundProvider, WebhookProvider } from './types.js'
import type { ProviderName } from '../schemas/refund.js'
import { DomainError } from '../lib/errors.js'
import { StripeProvider } from './stripe.provider.js'

const refundProviders = new Map<ProviderName, RefundProvider>()
const webhookProviders = new Map<ProviderName, WebhookProvider>()

export function registerRefundProvider(provider: RefundProvider): void {
  refundProviders.set(provider.name, provider)
}

export function registerWebhookProvider(provider: WebhookProvider): void {
  webhookProviders.set(provider.name, provider)
}

export function getRefundProvider(name: ProviderName): RefundProvider {
  const provider = refundProviders.get(name)
  if (!provider) throw new DomainError(`No refund provider registered for ${name}`, 'NO_PROVIDER', 500)
  return provider
}

export function getWebhookProvider(name: ProviderName): WebhookProvider {
  const provider = webhookProviders.get(name)
  if (!provider) throw new DomainError(`No webhook provider registered for ${name}`, 'NO_PROVIDER', 500)
  return provider
}

export function initProviders(): { refunds: RefundProvider[]; webhooks: WebhookProvider[] } {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (stripeKey && stripeWebhookSecret) {
    const stripe = new StripeProvider(stripeKey, stripeWebhookSecret)
    registerRefundProvider(stripe)
    registerWebhookProvider(stripe)
  }
  return {
    refunds: [...refundProviders.values()],
    webhooks: [...webhookProviders.values()],
  }
}