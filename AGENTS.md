# AGENTS.md — RefundFlow

Commands to verify work in this repo:

- Typecheck: `npm run typecheck`
- Tests: `npm run test`
- Lint: `npm run lint`
- Dev server: `npm run dev` (requires Postgres at DATABASE_URL)

Prisma:
- `npx prisma generate`
- `npx prisma migrate dev --name <name>`
- `npm run seed`

Architecture in README.md. The refund state machine in `src/machines/refund.machine.ts` is the load-bearing invariant; AI agent decisions are gated by it.