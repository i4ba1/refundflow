import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const order = await prisma.order.create({
    data: {
      externalId: 'pi_test_demo_001',
      provider: 'STRIPE',
      amount: 249.99,
      currency: 'USD',
      customerEmail: 'customer@example.com',
      customerName: 'Demo Customer',
    },
  })

  const highValueReason = 'PRODUCT_NOT_RECEIVED'
  const refund = await prisma.refund.create({
    data: {
      orderId: order.id,
      amount: 750,
      currency: 'USD',
      reason: highValueReason,
      status: 'UNDER_REVIEW',
      provider: 'STRIPE',
      idempotencyKey: 'seed-key-aaaaaa-0001',
    },
  })

  await prisma.refundAudit.create({
    data: {
      refundId: refund.id,
      action: 'SUBMIT_REVIEW',
      fromStatus: 'PENDING',
      toStatus: 'UNDER_REVIEW',
      actor: 'seed',
    },
  })

  console.log('seeded:', { orderId: order.id, refundId: refund.id })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())