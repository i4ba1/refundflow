import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import {
  CreateRefundSchema,
  RefundResponseSchema,
  RefundListSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
} from '../schemas/refund.js'
import { DomainError } from '../lib/errors.js'
import type { RefundService } from '../services/refund.service.js'
import type { WebhookService } from '../services/webhook.service.js'
import type { RefundWithOrder } from '../repositories/interfaces.js'
import type { AgentReviewResult } from '../ai/types.js'

type RefundResponseDTO = z.infer<typeof RefundResponseSchema>

export interface ApiDeps {
  refundService: RefundService
  webhookService: WebhookService
}

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Health check',
  responses: {
    200: {
      description: 'Service is healthy',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
})

const createRefundRoute = createRoute({
  method: 'post',
  path: '/refunds',
  tags: ['Refunds'],
  summary: 'Create a refund request',
  description:
    'Creates a refund. High-value refunds (>= $500) or refunds with reason FRAUDULENT are placed in UNDER_REVIEW for the AI agent.',
  request: { body: { content: { 'application/json': { schema: CreateRefundSchema } } } },
  responses: {
    201: { description: 'Refund created', content: { 'application/json': { schema: RefundResponseSchema } } },
    409: { description: 'Idempotency key already used', content: { 'application/json': { schema: ErrorResponseSchema } } },
    422: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
})

const getRefundRoute = createRoute({
  method: 'get',
  path: '/refunds/{id}',
  tags: ['Refunds'],
  summary: 'Get a refund by id',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Refund found', content: { 'application/json': { schema: RefundResponseSchema } } },
    404: { description: 'Refund not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
})

const listRefundsRoute = createRoute({
  method: 'get',
  path: '/refunds',
  tags: ['Refunds'],
  summary: 'List refunds',
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ example: '20' }),
      offset: z.string().optional().openapi({ example: '0' }),
    }),
  },
  responses: {
    200: { description: 'Refund list', content: { 'application/json': { schema: RefundListSchema } } },
  },
})

const reviewRoute = createRoute({
  method: 'post',
  path: '/refunds/{id}/review',
  tags: ['AI Review'],
  summary: 'Trigger the AI agent review of a refund',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Review completed', content: { 'application/json': { schema: RefundResponseSchema } } },
    422: { description: 'Not in UNDER_REVIEW state', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
})

const settleRoute = createRoute({
  method: 'post',
  path: '/refunds/{id}/settle',
  tags: ['Refunds'],
  summary: 'Settle a refund via the payment provider',
  description: 'Transitions APPROVED -> SETTLED and calls the configured provider refund API with idempotency.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Refund settled', content: { 'application/json': { schema: RefundResponseSchema } } },
    422: { description: 'Invalid transition', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Provider error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
})

const approveRoute = createRoute({
  method: 'post',
  path: '/refunds/{id}/approve',
  tags: ['Refunds'],
  summary: 'Manually approve a refund',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Refund approved', content: { 'application/json': { schema: RefundResponseSchema } } },
  },
})

const rejectRoute = createRoute({
  method: 'post',
  path: '/refunds/{id}/reject',
  tags: ['Refunds'],
  summary: 'Manually reject a refund',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Refund rejected', content: { 'application/json': { schema: RefundResponseSchema } } },
  },
})

const stripeWebhookRoute = createRoute({
  method: 'post',
  path: '/webhooks/stripe',
  tags: ['Webhooks'],
  summary: 'Stripe webhook receiver (signature-verified, idempotent)',
  request: {
    headers: z.object({ 'stripe-signature': z.string() }),
    body: { content: { 'text/plain': { schema: z.string() } } },
  },
  responses: {
    200: { description: 'Webhook processed (or duplicate skipped)', content: { 'application/json': { schema: z.object({ status: z.string() }) } } },
  },
})

export function createApiRoutes(deps: ApiDeps): OpenAPIHono {
  const app = new OpenAPIHono()

  app.openapi(healthRoute, (c) => c.json({ status: 'ok', ts: new Date().toISOString() }, 200))

  app.openapi(createRefundRoute, async (c) => {
    const refund = await deps.refundService.createRefund(c.req.valid('json'))
    return c.json(serializeRefund(refund), 201)
  })

  app.openapi(getRefundRoute, async (c) => {
    const { id } = c.req.valid('param')
    return c.json(serializeRefund(await deps.refundService.getRefund(id)), 200)
  })

  app.openapi(listRefundsRoute, async (c) => {
    const { limit, offset } = c.req.valid('query')
    const limitN = limit ? Number(limit) : 20
    const offsetN = offset ? Number(offset) : 0
    const result = await deps.refundService.listRefunds(limitN, offsetN)
    return c.json(
      { items: result.items.map(serializeRefund), total: result.total, limit: limitN, offset: offsetN },
      200,
    )
  })

  app.openapi(reviewRoute, async (c) => {
    const { id } = c.req.valid('param')
    return c.json(serializeRefund(await deps.refundService.triggerReview(id)), 200)
  })

  app.openapi(settleRoute, async (c) => {
    const { id } = c.req.valid('param')
    return c.json(serializeRefund(await deps.refundService.settleRefund(id)), 200)
  })

  app.openapi(approveRoute, async (c) => {
    const { id } = c.req.valid('param')
    return c.json(serializeRefund(await deps.refundService.approveRefund(id)), 200)
  })

  app.openapi(rejectRoute, async (c) => {
    const { id } = c.req.valid('param')
    return c.json(serializeRefund(await deps.refundService.rejectRefund(id)), 200)
  })

  app.openapi(stripeWebhookRoute, async (c) => {
    const signature = c.req.valid('header')['stripe-signature']
    const rawBody = await c.req.text()
    const result = await deps.webhookService.handle('STRIPE', rawBody, signature)
    return c.json(result, 200)
  })

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'RefundFlow API',
      version: '1.0.0',
      description:
        'AI-powered refund orchestration engine. Create refunds, route high-risk ones through an AI agent review, settle via payment providers (Stripe), and receive verified webhooks.',
    },
    servers: [{ url: process.env.WEBHOOK_BASE_URL || 'http://localhost:3527', description: 'API server' }],
  })

  app.get(
    '/docs',
    Scalar({
      url: '/api/openapi.json',
      theme: 'purple',
      pageTitle: 'RefundFlow API Reference',
      layout: 'modern',
    }),
  )

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400)
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', issues: err.issues } }, 422)
    }
    console.error('unhandled', err)
    return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
  })

  return app
}

function serializeRefund(r: RefundWithOrder): RefundResponseDTO {
  return {
    id: r.id,
    orderId: r.orderId,
    amount: Number(r.amount),
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    provider: r.provider,
    providerRefId: r.providerRefId,
    agentDecision: r.agentDecision,
    agentRationale: (r.agentRationale as AgentReviewResult | null) ?? null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}