import OpenAI from 'openai'
import { logger } from '../utils/logger.js'
import { withOpenAIPolicy } from '../lib/resilience.js'
import type { AgentReviewer, AgentReviewResult } from './types.js'
import type { RefundRepository } from '../repositories/interfaces.js'

interface RefundContext {
  refundId: string
  amount: number
  currency: string
  reason: string
  orderId: string
  customerEmail: string
  orderAmount: number
  provider: string
  previousRefundsCount: number
  daysSinceOrder: number
}

const SYSTEM_PROMPT = `You are a senior fraud analyst for an e-commerce refund orchestration platform.
Review the refund request and decide whether to APPROVE, REJECT, or escalate NEEDS_HUMAN.
Consider: refund-to-order ratio, high-value thresholds, fraud patterns, repeat refunders suspicious timing.
Return a JSON object ONLY with fields: decision (APPROVE|REJECT|NEEDS_HUMAN), confidence (0-1), rationale (string), signals (array of {signal, weight}).`

const AGENT_UNAVAILABLE: AgentReviewResult = {
  decision: 'NEEDS_HUMAN',
  confidence: 0,
  rationale: 'agent_unavailable',
  signals: [],
}

export class OpenAIRefundReviewAgent implements AgentReviewer {
  private client: OpenAI
  private model: string

  constructor(
    private refunds: RefundRepository,
    client?: OpenAI,
    model?: string,
  ) {
    this.client = client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 15_000 })
    this.model = model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  }

  async reviewRefund(refundId: string): Promise<AgentReviewResult> {
    const ctx = await this.gatherContext(refundId)
    logger.info('agent.review.start', { refundId })

    const result = await withOpenAIPolicy(async () => {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(ctx) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      })

      const content = completion.choices[0]?.message?.content
      if (!content) throw new Error('Agent returned empty response')

      try {
        return JSON.parse(content) as AgentReviewResult
      } catch (e) {
        throw new Error(`Agent returned invalid JSON: ${(e as Error).message}`)
      }
    }, AGENT_UNAVAILABLE)

    logger.info('agent.review.done', { refundId, decision: result.decision })
    return result
  }

  private async gatherContext(refundId: string): Promise<RefundContext> {
    const refund = await this.refunds.findById(refundId)
    if (!refund) throw new Error(`Refund not found for agent review: ${refundId}`)

    const previousRefunds = await this.refunds.countForCustomer(refund.order.customerEmail)
    const daysSinceOrder = Math.floor(
      (Date.now() - refund.order.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    )

    return {
      refundId: refund.id,
      amount: Number(refund.amount),
      currency: refund.currency,
      reason: refund.reason,
      orderId: refund.orderId,
      customerEmail: refund.order.customerEmail,
      orderAmount: Number(refund.order.amount),
      provider: refund.provider,
      previousRefundsCount: previousRefunds,
      daysSinceOrder,
    }
  }
}