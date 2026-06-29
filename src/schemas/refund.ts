import { z } from '@hono/zod-openapi'

export const RefundReasonSchema = z.enum([
  'FRAUDULENT',
  'DUPLICATE',
  'PRODUCT_NOT_RECEIVED',
  'PRODUCT_DEFECTIVE',
  'CUSTOMER_REQUEST',
  'OTHER',
])

export const ProviderNameSchema = z.enum(['STRIPE', 'PAYPAL'])

export const RefundStatusSchema = z.enum([
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SETTLED',
  'FAILED',
])

export const CreateRefundSchema = z.object({
  orderId: z.string().cuid().openapi({ example: 'ckabc1234567890xyz' }),
  amount: z.number().positive().max(1000000).openapi({ example: 750 }),
  currency: z.string().length(3).default('USD').openapi({ example: 'USD' }),
  reason: RefundReasonSchema,
  idempotencyKey: z.string().min(8).max(64).openapi({ example: 'key-12345678' }),
  provider: ProviderNameSchema,
})

export const AgentReviewResultSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'NEEDS_HUMAN']),
  confidence: z.number(),
  rationale: z.string(),
  signals: z.array(z.object({ signal: z.string(), weight: z.number() })),
})

export const RefundResponseSchema = z.object({
  id: z.string().openapi({ example: 'ckrefund0001' }),
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  reason: RefundReasonSchema,
  status: RefundStatusSchema,
  provider: ProviderNameSchema,
  providerRefId: z.string().nullable(),
  agentDecision: z.string().nullable(),
  agentRationale: AgentReviewResultSchema.nullable(),
  reviewedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const RefundListSchema = z.object({
  items: z.array(RefundResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
})

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
})

export const HealthResponseSchema = z.object({
  status: z.string(),
  ts: z.string().datetime(),
})

export type CreateRefundInput = z.infer<typeof CreateRefundSchema>
export type RefundReason = z.infer<typeof RefundReasonSchema>
export type ProviderName = z.infer<typeof ProviderNameSchema>
export type RefundStatus = z.infer<typeof RefundStatusSchema>