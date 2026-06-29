# RefundFlow — AI-Powered Refund Orchestration Engine

RefundFlow is a backend service that lets e-commerce merchants orchestrate refund workflows across payment providers (Stripe, PayPal) via API integrations and webhooks. A refund-review **AI agent** automatically reviews high-risk refund requests for fraud signals, while a **finite state machine** guarantees that no agent decision can violate business invariants. Every transition is recorded in an append-only audit trail.


---

## Table of contents
1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Architecture](#architecture)
4. [SOLID principles in this codebase](#solid-principles-in-this-codebase)
5. [Refund state machine](#refund-state-machine)
6. [AI agent design](#ai-agent-design)
7. [Idempotency & webhooks](#idempotency--webhooks)
8. [Accessing the API documentation](#accessing-the-api-documentation)
9. [Using the API with Postman](#using-the-api-with-postman)
10. [API reference (Scalar)](#api-reference-scalar)
11. [Error codes](#error-codes)
12. [tRPC gateway](#trpc-gateway)
13. [Resilience & idempotency guarantees](#resilience--idempotency-guarantees)
14. [Quick start](#quick-start)
15. [Environment variables](#environment-variables)
16. [Project structure](#project-structure)
17. [Quality gates](#quality-gates)
18. [Security note](#security-note)
19. [AI usage in this project](#ai-usage-in-this-project)
20. [Extending the system](#extending-the-system)
21. [Technical documentation](#technical-documentation)

---

## Features
- **Create refunds** against existing orders, with currency, reason, and provider.
- **Automatic risk routing** — refunds ≧ $500 or flagged `FRAUDULENT` are placed in `UNDER_REVIEW` for the AI agent.
- **AI agent review** — an OpenAI tool-calling agent gathers order history, refund ratio, days since order, and returns a structured `{ decision, confidence, rationale, signals }`. `NEEDS_HUMAN` is internally treated as `REJECT` so a human must intervene.
- **Manual approve / reject** endpoints with audit-trail entries.
- **Provider settlement** — calls the Stripe Refunds API with an idempotency key forwarded from the request; failures funnel into the `FAILED` terminal state.
- **Verified idempotent webhooks** — Stripe webhook signatures are verified; events are deduplicated via `externalEventId`; `refunds.succeeded` transitions a refund to `SETTLED`.
- **Scalar API documentation** at `/api/docs` generated from the same Zod schemas that validate requests.
- **tRPC gateway** at `/trpc` exposing typed procedures for dashboard clients.

## Tech stack
| Layer | Choice | Why |
|------|--------|-----|
| HTTP framework | **Hono** | Fast, edge-ready, first-class OpenAPI + tRPC adapters |
| REST + OpenAPI | **@hono/zod-openapi** | One Zod schema = validation + OpenAPI schema |
| API docs | **Scalar** (`@scalar/hono-api-reference`) | Modern, themeable reference UI |
| Typed RPC | **tRPC v11** | End-to-end types for internal dashboard clients |
| Validation | **Zod** | Single source of truth for validation + docs |
| ORM | **Prisma + PostgreSQL** | Type-safe schema, migrations, audit relations |
| Provider SDK | **Stripe SDK** | Real refunds + webhook signing |
| AI | **OpenAI (`gpt-4o-mini`, JSON mode)** | Structured agent decisions |
| Tests | **Vitest** | Native ESM, fast |
| Runtime | **Node.js + TypeScript (tsx dev)** | Strict mode, ESM modules |

## Architecture

```
                     ┌──────────────────────────────────────────────┐
                     │               Composition root               │
                     │  builds repos, agent, services, providers     │
                     └───────────────┬──────────────────────────────┘
                                     │ injects
            ┌────────────────────────┼────────────────────────┐
            ▼                        ▼                        ▼
     RefundService            WebhookService           OpenAIRefundReviewAgent
    (uses RefundRepository,   (uses WebhookRepository,  (implements AgentReviewer,
     OrderRepository,          RefundRepository,          uses RefundRepository)
     AgentReviewer,            WebhookProvider)
     RefundProvider resolver)
            │                        │                        │
            ▼                        ▼                        ▼
   RefundStateMachine        StripeProvider (implements          OpenAI API
   (pure functions)          RefundProvider + WebhookProvider)
```

### Flow of a high-risk refund
```
POST /api/refunds
  → RefundService.createRefund
    → validates order + idempotency + amount
    → shouldTriggerReview() == true
    → persists Refund with status = UNDER_REVIEW

POST /api/refunds/:id/review
  → RefundService.triggerReview
    → AgentReviewer.reviewRefund
      → gathers context (prior refunds, ratio, days)
      → OpenAI JSON-mode decision
    → transition(UNDER_REVIEW, APPROVE|REJECT)   // FSM throws on illegal moves
    → persists decision + rationale

POST /api/refunds/:id/settle
  → RefundService.settleRefund
    → transition(APPROVED, SETTLE)
    → StripeProvider.createRefund (idempotency key forwarded)
    → on failure → transition(SETTLED, FAIL)

POST /api/webhooks/stripe   (signature-verified, deduplicated)
  → WebhookService.handle
    → parseWebhookEvent (Stripe SDK)
    → dedupe by externalEventId
    → WebhookHandler.handle (OCP: register per event type)
    → if refunds.succeeded → refund.update(SETTLED) + audit
```

---

## SOLID principles in this codebase

This refactor was driven by applying SOLID explicitly. Each principle maps to concrete code.

### S — Single Responsibility
- `src/machines/refund.machine.ts` — **only** defines transitions and review rules. No I/O, no persistence.
- `src/services/refund.service.ts` — orchestrates the refund lifecycle; delegates persistence to `RefundRepository`, provider calls to `RefundProvider`, and review to `AgentReviewer`.
- `src/services/webhook.service.ts` — only ingests, deduplicates, and dispatches webhook events. Per-event-type logic lives in pluggable `WebhookHandler` instances, not inside the service.
- `src/routes/api.ts` — HTTP layer only: maps Hono requests to service calls and serializes DTOs.
- `src/ai/review-agent.ts` — only builds the agent prompt, calls OpenAI, and parses the structured response.

### O — Open/Closed
- **Webhook handlers** are registered, not hard-coded:
  ```ts
  // services/webhook.service.ts
  register(handler: WebhookHandler): void { this.handlers.set(handler.type, handler) }
  ```
  Adding support for `refunds.failed` or a PayPal event = add a new `WebhookHandler`, not edit `WebhookService`.
- **Providers** register into two maps (`registerRefundProvider`, `registerWebhookProvider`). A PayPal implementation can register itself without modifying existing code.
- **Routes** are declared with `createRoute(...)` and attached via `app.openapi(route, handler)` — new routes are additive.

### L — Liskov Substitution
- `OpenAIRefundReviewAgent implements AgentReviewer`. The service accepts the interface, so a `MockAgent` (used in tests) or a future `AnthropicRefundReviewAgent` substitutes without any code change to `RefundService`.
- `StripeProvider implements RefundProvider, WebhookProvider`. Any other provider that conforms to those interfaces substitutes transparently.

### I — Interface Segregation
The original single `Provider` interface forced every provider to implement webhook methods even if it only did refunds. It was split:
```ts
// providers/types.ts
export interface RefundProvider  { name; createRefund(input): ... }
export interface WebhookProvider  { name; parseWebhookEvent(raw, sig): ... }
```
`StripeProvider` implements **both** (it can). A refunds-only provider can implement only `RefundProvider`. Consumers depend on the narrow interface they need (`RefundService` depends on `RefundProvider`, `WebhookService` depends on `WebhookProvider`).

### D — Dependency Inversion
High-level modules depend on **abstractions**, not concretions:
```ts
// services/refund.service.ts
export class RefundService {
  constructor(
    private refunds: RefundRepository,       // interface, not PrismaClient
    private orders: OrderRepository,         // interface
    private agent: AgentReviewer,            // interface, not OpenAIRefundReviewAgent
    private resolveProvider: RefundProviderResolver,  // function, not a registry import
  ) {}
}
```
The **composition root** (`src/server/composition.ts`) is the only place that knows about concretions:
```ts
const refundRepository = new PrismaRefundRepository(prisma)
const agent = new OpenAIRefundReviewAgent(refundRepository)
const refundService = new RefundService(refundRepository, orderRepository, agent, getRefundProvider)
```
- No service imports the `PrismaClient` global directly (the old `src/db/client.ts` was deleted).
- No service imports `getRefundProvider` directly; it receives a resolver function.
- The agent receives `RefundRepository` instead of importing `PrismaClient`, so it can be unit-tested with an in-memory repo.
- Module-level singletons (`export const refundService = new RefundService()`) were removed; the composition root is the only builder.

---

## Refund state machine

```
PENDING ──SUBMIT_REVIEW──▶ UNDER_REVIEW
PENDING ──APPROVE────────▶ APPROVED
PENDING ──REJECT─────────▶ REJECTED
UNDER_REVIEW ──APPROVE───▶ APPROVED
UNDER_REVIEW ──REJECT────▶ REJECTED
APPROVED ──SETTLE────────▶ SETTLED
*        ──FAIL──────────▶ FAILED   (terminal)

Terminal: REJECTED, SETTLED, FAILED
```

The machine is implemented as pure functions in `src/machines/refund.machine.ts`:
- `transition(current, event)` → returns the next status or **throws `InvalidTransitionError`**.
- `canTransition(current, event)` → boolean for guards/probes.
- `shouldTriggerReview(amount, reason)` → routes high-value/fraud refunds to the agent.

This is the load-bearing invariant of the system. The AI agent's decision is **funneled through `transition()`**; it cannot bypass the FSM even if its output is malformed.

## AI agent design

The agent is a tool-calling pattern implemented with OpenAI **JSON mode** (`response_format: { type: 'json_object' }`):

1. **Gather context** — `RefundRepository.findById` + `countForCustomer` (prior successful refunds, refund-to-order ratio, days since order).
2. **Prompt** — a senior-fraud-analyst system prompt + the JSON context as the user message.
3. **Decide** — returns:
   ```json
   {
     "decision": "APPROVE|REJECT|NEEDS_HUMAN",
     "confidence": 0.0-1.0,
     "rationale": "string",
     "signals": [{ "signal": "repeat_refunder", "weight": 0.8 }]
   }
   ```
4. **Gate** — `RefundService.triggerReview` maps the decision to a state-machine event (`NEEDS_HUMAN` is mapped to `REJECT` so a human retries manually), then calls `transition()` which throws on illegal moves.
5. **Persist** — the full `AgentReviewResult` is stored in `Refund.agentRationale` so every decision is auditable.

The agent **cannot** deploy code, mutate state directly, or call providers. It only returns a recommendation that the platform validates and acts on.

## Idempotency & webhooks
- **Refund creation** requires an `idempotencyKey` (8–64 chars), enforced unique in Postgres. The same key returns a `409 Conflict` instead of a duplicate refund.
- **Provider calls** forward `idempotencyKey` to Stripe as the SDK idempotency key.
- **Webhook ingestion** stores each event with a unique `externalEventId` and a `processed` flag. Re-deliveries look up the id and short-circuit with `{ status: 'already_processed' }`.
- **Signature verification** happens inside `StripeProvider.parseWebhookEvent` via `stripe.webhooks.constructEvent`; invalid signatures throw `ProviderError` (502).

## Accessing the API documentation

RefundFlow ships live API documentation generated from the **same Zod schemas** that validate requests at runtime (`src/schemas/refund.ts`), so the docs can never drift from the implementation.

| Resource | URL | Format |
|----------|-----|--------|
| Scalar reference UI | http://localhost:3527/api/docs | HTML (interactive) |
| OpenAPI 3.0 spec | http://localhost:3527/api/openapi.json | JSON |
| tRPC endpoints | http://localhost:3527/trpc | JSON (link transport) |

### Try it from the browser
1. Start the server: `npm run dev`
2. Open http://localhost:3527/api/docs — Scalar's "modern" layout (theme: purple).
3. Each operation has a **Try it out** button that fires a real request against the running server.

### Importing the spec elsewhere
The OpenAPI JSON at `/api/openapi.json` is a valid OpenAPI 3.0 document. You can import it into:
- **Postman** — *Import → Link → `http://localhost:3527/api/openapi.json`* (see [Using the API with Postman](#using-the-api-with-postman) below).
- **Stoplight**, **Insomnia**, **Swagger UI**, **Redoc**, **Bump.sh** — all accept the same URL or file.

The server entry in the spec is driven by `WEBHOOK_BASE_URL` (defaults to `http://localhost:3527`); set it to your public URL when deploying.

---

## Using the API with Postman

Two ways to get going: import our ready-made collection, or generate one from the live OpenAPI spec.

### Option A — Import the bundled collection (recommended)

A ready-to-use collection with chained variables is committed at [`postman/refundflow.postman_collection.json`](./postman/refundflow.postman_collection.json). It walks the full refund lifecycle and auto-captures `refundId` between requests.

1. In Postman: **File → Import → Upload Files** → select `postman/refundflow.postman_collection.json`.
2. Create or select an environment and set the collection variables (the collection view → **Variables** tab):
   | Variable | Initial value | Notes |
   |----------|---------------|-------|
   | `baseUrl` | `http://localhost:3527` | API host |
   | `orderId` | *(leave blank)* | Set by the seed request, or paste the id printed by `npm run seed` |
   | `refundId` | *(leave blank)* | Auto-captured from the **Create refund** response |
   | `idempotencyKey` | *(auto-generated)* | Random key per create; override if you want a fixed one |
3. Run **Seed: ensure order exists** (or `npm run seed`) to obtain an `orderId`, then run **Create refund (high-risk)** — its test script sets `refundId` for the rest of the chain.
4. Continue through **Trigger AI review → Settle via provider**. The webhook request documents how to forward Stripe CLI events.

### Option B — Import the live OpenAPI spec

1. Start the server (`npm run dev`).
2. In Postman: **Import → Link → `http://localhost:3527/api/openapi.json`**.
3. Postman generates a collection from the spec. You'll need to set the `baseUrl` variable yourself; the spec's `servers[0].url` is honored automatically.

> **Option A vs B:** Option A includes test scripts that chain `refundId` between requests and pre-filled example responses. Option B is always in sync with the latest schema but lacks the lifecycle chaining.

### Manual sequence (curl)

```bash
# 1. Create a high-risk refund (amount >= 500 → UNDER_REVIEW)
curl -X POST http://localhost:3527/api/refunds \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ckabc1234567890xyz",
    "amount": 750,
    "currency": "USD",
    "reason": "PRODUCT_NOT_RECEIVED",
    "idempotencyKey": "key-12345678",
    "provider": "STRIPE"
  }'
# → 201 { "id": "ck...", "status": "UNDER_REVIEW", ... }

# 2. Trigger the AI agent review (requires OPENAI_API_KEY)
curl -X POST http://localhost:3527/api/refunds/ck.../review
# → 200 { "status": "APPROVED", "agentDecision": "APPROVE", "agentRationale": {...} }

# 3. Settle via Stripe (requires STRIPE_SECRET_KEY)
curl -X POST http://localhost:3527/api/refunds/ck.../settle
# → 200 { "status": "SETTLED", "providerRefId": "re_..." }
```

### Local webhook testing

Postman can't sign Stripe webhook payloads, so use the Stripe CLI to forward real events:

```bash
stripe listen --forward-to http://localhost:3527/api/webhooks/stripe
# forwards signed events; the receiver verifies the signature and dedupes by externalEventId
```

---

## API reference (Scalar)

After starting the server, open:

- **Scalar UI:** http://localhost:3527/api/docs
- **OpenAPI JSON:** http://localhost:3527/api/openapi.json

All schemas, examples, and response codes are generated from the same Zod schemas used for runtime validation (`src/schemas/refund.ts`) via `@hono/zod-openapi`'s `.openapi()` metadata.

### REST endpoints (`/api`)
| Method | Path | Purpose | Request body | Success response |
|--------|------|---------|--------------|-------------------|
| GET | `/api/health` | Health check | — | `200 { status, ts }` |
| POST | `/api/refunds` | Create a refund (auto-routes to review if high-risk) | `CreateRefundSchema` | `201 RefundResponse` |
| GET | `/api/refunds` | List refunds (`?limit&offset`) | — | `200 RefundList` |
| GET | `/api/refunds/:id` | Fetch a refund | — | `200 RefundResponse` |
| POST | `/api/refunds/:id/review` | Trigger the AI agent review | — | `200 RefundResponse` |
| POST | `/api/refunds/:id/settle` | Settle via the payment provider | — | `200 RefundResponse` |
| POST | `/api/refunds/:id/approve` | Manual approve (admin) | — | `200 RefundResponse` |
| POST | `/api/refunds/:id/reject` | Manual reject (admin) | — | `200 RefundResponse` |
| POST | `/api/webhooks/stripe` | Stripe webhook receiver (verified, idempotent) | `text/plain` raw body + `stripe-signature` header | `200 { status }` |

### `CreateRefundSchema` (request body)
| Field | Type | Constraints |
|-------|------|-------------|
| `orderId` | string | cuid |
| `amount` | number | positive, ≤ 1,000,000 |
| `currency` | string | 3 chars, default `USD` |
| `reason` | enum | `FRAUDULENT` \| `DUPLICATE` \| `PRODUCT_NOT_RECEIVED` \| `PRODUCT_DEFECTIVE` \| `CUSTOMER_REQUEST` \| `OTHER` |
| `idempotencyKey` | string | 8–64 chars, unique |
| `provider` | enum | `STRIPE` \| `PAYPAL` |

### `RefundResponse` (shared response body)
```json
{
  "id": "ckrefund0001",
  "orderId": "ckabc1234567890xyz",
  "amount": 750,
  "currency": "USD",
  "reason": "PRODUCT_NOT_RECEIVED",
  "status": "UNDER_REVIEW",
  "provider": "STRIPE",
  "providerRefId": null,
  "agentDecision": null,
  "agentRationale": null,
  "reviewedAt": null,
  "createdAt": "2026-06-29T10:00:00.000Z",
  "updatedAt": "2026-06-29T10:00:00.000Z"
}
```
`status` is one of: `PENDING`, `UNDER_REVIEW`, `APPROVED`, `REJECTED`, `SETTLED`, `FAILED`.

### Example — create a high-risk refund
```bash
curl -X POST http://localhost:3527/api/refunds \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ckabc1234567890xyz",
    "amount": 750,
    "currency": "USD",
    "reason": "PRODUCT_NOT_RECEIVED",
    "idempotencyKey": "key-12345678",
    "provider": "STRIPE"
  }'
```
A $750 refund with `PRODUCT_NOT_RECEIVED` is above the $500 threshold → status is `UNDER_REVIEW`.

### Example — list refunds with pagination
```bash
curl "http://localhost:3527/api/refunds?limit=20&offset=0"
```
```json
{
  "items": [ /* RefundResponse[] */ ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### Example — trigger AI review
```bash
curl -X POST http://localhost:3527/api/refunds/ckrefund0001/review
```
After the agent runs, the response includes the structured decision:
```json
{
  "id": "ckrefund0001",
  "status": "APPROVED",
  "agentDecision": "APPROVE",
  "agentRationale": {
    "decision": "APPROVE",
    "confidence": 0.82,
    "rationale": "Low refund-to-order ratio, first-time refunder.",
    "signals": [{ "signal": "repeat_refunder", "weight": 0.1 }]
  },
  "reviewedAt": "2026-06-29T10:01:00.000Z"
}
```

### Example — settle a refund
```bash
curl -X POST http://localhost:3527/api/refunds/ckrefund0001/settle
```
Returns the refund with `status: SETTLED` (or `FAILED` if Stripe errored) and `providerRefId` populated.

### Example — Stripe webhook
```bash
curl -X POST http://localhost:3527/api/webhooks/stripe \
  -H "stripe-signature: t=...,v1=..." \
  -H "Content-Type: text/plain" \
  --data-binary @event.json
```
Responses: `{ "status": "processed" }` on first delivery, `{ "status": "already_processed" }` on replays. Invalid signatures return `502 PROVIDER_ERROR`.

## Error codes

All errors share one envelope: `{ "error": { "code", "message", "issues?" } }`. The codes and status codes are generated from `src/lib/errors.ts` plus the central handler in `src/routes/api.ts`.

| HTTP | `code` | When |
|------|--------|------|
| 404 | `NOT_FOUND` | Order or refund id not found |
| 409 | `CONFLICT` | `idempotencyKey` already used |
| 422 | `VALIDATION_ERROR` | Zod schema failure, business rule violation, or illegal FSM transition (e.g. reviewing a refund not in `UNDER_REVIEW`) |
| 502 | `PROVIDER_ERROR` | Stripe refund create or webhook signature verification failure |
| 401 | `UNAUTHORIZED` | *(Reserved — auth not yet enforced, see [Security note](#security-note))* |
| 500 | `NO_PROVIDER` | No provider registered for the requested `ProviderName` |
| 500 | `INTERNAL` | Unhandled exception (logged via `console.error`) |

Example error body:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Refund amount exceeds order amount",
    "issues": [
      { "path": ["amount"], "message": "Refund amount exceeds order amount" }
    ]
  }
}
```

## tRPC gateway

Internal dashboard clients can use the typed tRPC router at `/trpc/*`. Procedures mirror the REST surface and call the same injected `RefundService`, so behavior is identical.

| Procedure | Type | Input |
|-----------|------|-------|
| `refunds.createRefund` | mutation | `CreateRefundSchema` |
| `refunds.getRefund` | query | `{ id }` |
| `refunds.listRefunds` | query | `{ limit?, offset? }` |
| `refunds.triggerReview` | mutation | `{ refundId }` |
| `refunds.settleRefund` | mutation | `{ refundId }` |
| `refunds.approveRefund` | mutation | `{ refundId, actor? }` |
| `refunds.rejectRefund` | mutation | `{ refundId, actor? }` |

The router is built in the composition root (`createAppRouter({ refundService })`) so procedures call the same injected service as the REST layer.

### Calling tRPC over plain HTTP
tRPC v11 uses a link transport that wraps the input in `{ "json": <input> }`:

```bash
# Mutation
curl -X POST http://localhost:3527/trpc/refunds.createRefund \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "orderId": "ckabc1234567890xyz",
      "amount": 750,
      "currency": "USD",
      "reason": "PRODUCT_NOT_RECEIVED",
      "idempotencyKey": "trpc-key-0001",
      "provider": "STRIPE"
    }
  }'

# Query (input is URL-encoded JSON)
curl "http://localhost:3527/trpc/refunds.getRefund?input=%7B%22json%22%3A%7B%22id%22%3A%22ckrefund0001%22%7D%7D"
```

### Calling tRPC from a TypeScript client
```bash
npm install @trpc/client @trpc/server
```
```ts
import { createTRPCProxyClient, httpLink } from '@trpc/client'
import type { AppRouter } from './src/routes/trpc-router.js'

const client = createTRPCProxyClient<AppRouter>({
  links: [httpLink({ url: 'http://localhost:3527/trpc' })],
})

const refund = await client.refunds.createRefund.mutate({
  orderId: 'ckabc1234567890xyz',
  amount: 750,
  currency: 'USD',
  reason: 'PRODUCT_NOT_RECEIVED',
  idempotencyKey: 'trpc-key-0001',
  provider: 'STRIPE',
})
```
The `AppRouter` type is exported from `src/routes/trpc-router.ts:50`, giving you end-to-end type inference.

## Resilience & idempotency guarantees

RefundFlow treats downstream calls (Stripe, OpenAI) as fallible. The resilience layer lives in [`src/lib/resilience.ts`](./src/lib/resilience.ts) and is built on [**`cockatiel`**](https://github.com/connor4312/cockatiel) — the Node/TS port of Resilience4j concepts (Retry, CircuitBreaker, Timeout, Fallback as composable policies).

### Idempotency at every layer

| Layer | Mechanism | On replay |
|-------|-----------|-----------|
| `POST /api/refunds` | `idempotencyKey` (8–64 chars) unique in `Refund.idempotencyKey` | `409 CONFLICT` |
| Settlement call to Stripe | `idempotencyKey` forwarded to Stripe SDK | Stripe returns the original `re_xxx` (no double-refund) |
| Stripe webhook ingestion | `WebhookEvent.externalEventId` unique + `processed` flag | `{ status: "already_processed" }` |
| Settle reconcile | `findByProviderRefId` checks for an existing settled row | If a previous attempt actually settled, returns the existing row instead of transitioning to `FAILED` |

### Retry + circuit breaker policy table

| Downstream | Retries | Timeout | Circuit breaker | Fallback |
|------------|---------|---------|-----------------|----------|
| Stripe refunds | 3 attempts, exp + jitter (200 ms → 2 s) | 8 s | Open after 5 consecutive failures; probe after 30 s | — (throws `ProviderError` 502) |
| Stripe webhooks | none | 5 s | none | — |
| OpenAI agent | 2 attempts, exp + jitter (500 ms → 1.5 s) | 15 s | Open after 10 consecutive failures; probe after 60 s | `{ decision: 'NEEDS_HUMAN' }` → FSM maps to `REJECTED` (terminal but human-reviewable) |

Both SDK clients are constructed with `maxRetries: 0` so retry behavior has a single source of truth in our policies (otherwise the SDK would also retry and our circuit breaker would never open).

### What gets retried

`isRetryableStripeError` returns `true` for: HTTP `408 / 429 / 500 / 502 / 503 / 504`, `StripeConnectionError`, `StripeAPIError` with a retryable status, and Node `ECONNRESET / ETIMEDOUT / ENETUNREACH / EAI_AGAIN / ECONNREFUSED / EPIPE`. Everything else (`StripeInvalidRequestError`, 4xx other than 408/429) is treated as terminal and surfaces immediately.

### Webhooks are intentionally NOT retried in-process

Stripe's own delivery model retries failed webhooks with exponential backoff for up to 3 days. Our safety net is the dedup table (`WebhookEvent.externalEventId` unique) and the `processed` flag. The only resilience applied is a 5 s aggressive timeout on signature verification.

### Logs to watch

`resilience.retry`, `resilience.retry.exhausted`, `resilience.circuit.open`, `resilience.circuit.halfopen`, `resilience.circuit.close`, `resilience.timeout`, `refund.settle.reconciled` — all JSON-structured on stdout. See [`docs/TECHNICAL.md` §15](./docs/TECHNICAL.md#15-resilience-retry-circuit-breaker-reconcile) for the full table and tuning guide.

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#   set DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, OPENAI_API_KEY

# 3. Database
npx prisma migrate dev --name init
npm run seed            # creates a demo order + an under-review refund

# 4. Run
npm run dev             # http://localhost:3527
#   API docs: http://localhost:3527/api/docs
```

Verify the build:
```bash
npm run typecheck       # strict TS, no errors
npm run test            # 15/15 passing
```

## Environment variables
| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | Postgres connection string |
| `STRIPE_SECRET_KEY` | for settlement | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | for webhooks | Stripe webhook signing secret |
| `OPENAI_API_KEY` | for review | OpenAI key |
| `OPENAI_MODEL` | no | Defaults to `gpt-4o-mini` |
| `PORT` | no | Defaults to `3527` |
| `NODE_ENV` | no | `development` enables Prisma query logging |
| `WEBHOOK_BASE_URL` | no | Public URL used in the OpenAPI server entry |

## Project structure
```
prisma/
├── schema.prisma          Order, Refund, RefundAudit, WebhookEvent
└── seed.ts                Demo order + under-review refund
src/
├── server/
│   ├── index.ts           Hono app + tRPC adapter + boot
│   └── composition.ts     Composition root: wires all dependencies
├── routes/
│   ├── api.ts             OpenAPIHono REST routes + Scalar + openapi.json
│   └── trpc-router.ts     tRPC router factory
├── services/
│   ├── refund.service.ts  Refund lifecycle orchestration
│   └── webhook.service.ts Webhook ingest + dispatch
├── machines/
│   └── refund.machine.ts  Finite state machine + review rules (pure)
├── repositories/
│   ├── interfaces.ts      RefundRepository, OrderRepository, WebhookRepository
│   └── prisma.repositories.ts  Prisma implementations
├── providers/
│   ├── types.ts           RefundProvider + WebhookProvider (segregated)
│   ├── stripe.provider.ts StripeProvider (implements both)
│   └── registry.ts        Provider registry + initProviders()
├── ai/
│   ├── types.ts           AgentReviewer interface + AgentReviewResult
│   └── review-agent.ts    OpenAIRefundReviewAgent (implements AgentReviewer)
├── schemas/
│   └── refund.ts          Zod schemas (validation + OpenAPI metadata)
├── lib/
│   ├── errors.ts          DomainError hierarchy (code + status)
│   └── resilience.ts      cockatiel policies: retry + circuit breaker + timeout + fallback
└── utils/
    └── logger.ts          Structured JSON logger
tests/
├── refund.machine.test.ts FSM transition + review-rule tests
├── refund.schema.test.ts Zod schema validation tests
└── resilience.test.ts     isRetryableStripeError + retry/CB/fallback behavior
```

## Quality gates
| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Strict TypeScript, no emission |
| `npm run test` | Vitest — 15 FSM + Zod tests + resilience tests (retry, circuit breaker, fallback) |
| `npm run lint` | ESLint (configurable) |
| `npm run dev` | Hot-reload dev server via tsx |
| `npx prisma migrate dev` | Apply schema migrations |

## Security note

> ⚠️ **RefundFlow currently has no authentication or authorization.** Every endpoint — including admin-only ones like `/approve` and `/reject` — is publicly callable. This is acceptable for local development and the demo scope but **must not be deployed to production as-is**.

### What is secured today
- **Stripe webhooks** — signatures are verified via `stripe.webhooks.constructEvent` (`src/providers/stripe.provider.ts:47`). Tampered events return `502 PROVIDER_ERROR`.
- **Idempotency** — refunds require a unique `idempotencyKey`, so a replayed create returns `409 CONFLICT` instead of a duplicate.
- **CORS** — currently wide-open (`cors()` in `src/server/index.ts:11`); tighten before production.

### What is NOT secured
- No API key / JWT / session on `/api/*` or `/trpc/*`.
- Admin transitions (`/approve`, `/reject`) accept any caller.
- Provider keys are read from env vars at boot and held in memory by `StripeProvider`.

### Recommended production hardening
1. Add a Hono auth middleware (`bearerAuth` or `hono/jwt`) before `/api/refunds/*` — the existing `UnauthorizedError` (`src/lib/errors.ts:40`) is already plumbed for this.
2. Enforce an `admin` role on `/approve` and `/reject`; the `actor` parameter exists in `RefundService` but isn't yet read from the request.
3. Restrict CORS to known dashboard origins.
4. Load `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `OPENAI_API_KEY` from a secrets manager (Doppler, AWS Secrets Manager, Vault) rather than `.env`.
5. Add rate limiting (`hono/rate-limiter`) on `/api/refunds` and `/api/refunds/:id/review` — LLM calls are costly.
6. Emit `RefundAudit` entries from every mutating method (currently only `approve`/`reject` write audit rows).

See [`docs/TECHNICAL.md` §8](./docs/TECHNICAL.md#8-security-model) for the full security model.

## AI usage in this project
- **AI agent reviews refunds** (`src/ai/review-agent.ts`) — the product's defining feature.
- **Guards, not trust** — agent output is parsed as JSON, validated, funneled through the FSM, and audited. Quality stays owned by the platform.
- **Schemas single-source** — Zod schemas drive both validation and the Scalar docs, so the AI's contract with the platform is explicit and tested.

## Extending the system
- **Add a PayPal provider** — implement `RefundProvider` and/or `WebhookProvider`, call `registerRefundProvider` / `registerWebhookProvider` in `initProviders()`. No service code changes.
- **Add a webhook event type** — register a new `WebhookHandler` with `webhookService.register({ type, handle })`. No edits to `WebhookService`.
- **Swap the agent** — implement `AgentReviewer` and pass it to `new RefundService(...)` in the composition root.
- **Swap the database** — implement `RefundRepository` / `OrderRepository` / `WebhookRepository` against a different driver; inject in the composition root.

## Technical documentation

For an in-depth engineering reference — architecture diagrams, data model ERD, formal FSM definition, full API contract, error handling, security model, idempotency guarantees, observability, testing strategy, extension points, and sequence diagrams — see [`docs/TECHNICAL.md`](./docs/TECHNICAL.md).

A ready-to-use Postman collection with chained variables for the full refund lifecycle is at [`postman/refundflow.postman_collection.json`](./postman/refundflow.postman_collection.json).

License: MIT