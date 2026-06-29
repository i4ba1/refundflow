import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { createApiRoutes } from '../routes/api.js'
import { createAppRouter } from '../routes/trpc-router.js'
import { buildCompositionRoot } from './composition.js'
import { logger } from '../utils/logger.js'

const app = new Hono()
app.use('*', cors())

const { refundService, webhookService } = buildCompositionRoot()

const api = createApiRoutes({ refundService, webhookService })
app.route('/api', api)

const appRouter = createAppRouter({ refundService })

app.all('/trpc/*', (c) =>
  fetchRequestHandler({
    endpoint: '/trpc',
    req: c.req.raw,
    router: appRouter,
    createContext: () => ({}),
  }),
)

const port = Number(process.env.PORT || 3527)

serve({ fetch: app.fetch, port }, (info) => {
  logger.info('server.started', { port: info.port, docs: `http://localhost:${info.port}/api/docs` })
})

export { app }