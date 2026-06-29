import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { CreateRefundSchema } from '../schemas/refund.js'
import type { RefundService } from '../services/refund.service.js'

export interface TrpcDeps {
  refundService: RefundService
}

export function createAppRouter(deps: TrpcDeps) {
  const t = initTRPC.create()

  return t.router({
    createRefund: t.procedure.input(CreateRefundSchema).mutation(async ({ input }) => {
      return deps.refundService.createRefund(input)
    }),

    getRefund: t.procedure.input(z.object({ id: z.string().cuid() })).query(async ({ input }) => {
      return deps.refundService.getRefund(input.id)
    }),

    listRefunds: t.procedure
      .input(z.object({ limit: z.number().min(1).max(100).default(20), offset: z.number().min(0).default(0) }))
      .query(async ({ input }) => {
        return deps.refundService.listRefunds(input.limit, input.offset)
      }),

    triggerReview: t.procedure.input(z.object({ refundId: z.string().cuid() })).mutation(async ({ input }) => {
      return deps.refundService.triggerReview(input.refundId)
    }),

    settleRefund: t.procedure.input(z.object({ refundId: z.string().cuid() })).mutation(async ({ input }) => {
      return deps.refundService.settleRefund(input.refundId)
    }),

    approveRefund: t.procedure
      .input(z.object({ refundId: z.string().cuid(), actor: z.string().optional() }))
      .mutation(async ({ input }) => {
        return deps.refundService.approveRefund(input.refundId, input.actor)
      }),

    rejectRefund: t.procedure
      .input(z.object({ refundId: z.string().cuid(), actor: z.string().optional() }))
      .mutation(async ({ input }) => {
        return deps.refundService.rejectRefund(input.refundId, input.actor)
      }),
  })
}

export type AppRouter = ReturnType<typeof createAppRouter>