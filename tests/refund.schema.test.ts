import { describe, it, expect } from 'vitest'
import { CreateRefundSchema } from '../src/schemas/refund'

describe('CreateRefundSchema', () => {
  const validBase = {
    orderId: 'ckabc1234567890xyz',
    amount: 100,
    currency: 'USD',
    reason: 'CUSTOMER_REQUEST',
    idempotencyKey: 'key-12345678',
    provider: 'STRIPE',
  }

  it('parses valid input', () => {
    const result = CreateRefundSchema.parse(validBase)
    expect(result.amount).toBe(100)
  })

  it('defaults currency to USD', () => {
    const { currency, ...rest } = validBase
    expect(CreateRefundSchema.parse(rest).currency).toBe('USD')
  })

  it('rejects non-positive amount', () => {
    expect(() => CreateRefundSchema.parse({ ...validBase, amount: -5 })).toThrow()
  })

  it('rejects invalid reason enum', () => {
    expect(() => CreateRefundSchema.parse({ ...validBase, reason: 'WHATEVER' })).toThrow()
  })

  it('rejects short idempotencyKey', () => {
    expect(() => CreateRefundSchema.parse({ ...validBase, idempotencyKey: 'short' })).toThrow()
  })
})