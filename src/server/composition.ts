import { PrismaClient } from '@prisma/client'
import OpenAI from 'openai'
import { PrismaRefundRepository, PrismaOrderRepository, PrismaWebhookRepository } from '../repositories/prisma.repositories.js'
import { OpenAIRefundReviewAgent } from '../ai/review-agent.js'
import { RefundService } from '../services/refund.service.js'
import { WebhookService } from '../services/webhook.service.js'
import { getRefundProvider, getWebhookProvider, initProviders } from '../providers/registry.js'
import { logger } from '../utils/logger.js'

export interface CompositionRoot {
  refundService: RefundService
  webhookService: WebhookService
}

export function buildCompositionRoot(): CompositionRoot {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
  })

  const refundRepository = new PrismaRefundRepository(prisma)
  const orderRepository = new PrismaOrderRepository(prisma)
  const webhookRepository = new PrismaWebhookRepository(prisma)

  initProviders()

  const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: 15_000,
  })
  const agent = new OpenAIRefundReviewAgent(refundRepository, openaiClient)

  const refundService = new RefundService(
    refundRepository,
    orderRepository,
    agent,
    getRefundProvider,
  )

  const webhookService = new WebhookService(
    webhookRepository,
    getWebhookProvider,
    refundRepository,
  )

  logger.info('composition.root.built')

  return { refundService, webhookService }
}