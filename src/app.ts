import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import type { AppEnv } from './bindings'
import { requireAdmin, requireCsrf, requireSession } from './auth/session'
import { authRoutes } from './api/auth'
import { wikiRoutes } from './api/wiki'
import { recipientRoutes } from './api/recipients'
import { templateRoutes } from './api/templates'
import { monitorRoutes } from './api/monitor'
import { RunRepository } from './repositories/runs'
import { FeishuClient } from './feishu/client'
import { fail, ok } from './shared/response'
import { AppError } from './shared/errors'
import { getStoredUserToken } from './auth/oauth'

const app = new Hono<AppEnv>()

app.use('*', requestId())
app.use('*', async (c, next) => {
  c.set('requestId', c.get('requestId') || crypto.randomUUID())
  await next()
})

app.get('/api/health', (c) => ok(c, { status: 'ok', timestamp: new Date().toISOString() }))
app.route('/api/auth', authRoutes)

app.use('/api/wiki/*', requireSession)
app.use('/api/recipients/*', requireSession)
app.use('/api/recipient-candidates', requireSession)
app.use('/api/templates/*', requireSession)
app.use('/api/monitor/*', requireSession)
app.use('/api/runs/*', requireSession)
app.use('/api/changes', requireSession)
app.use('/api/wiki/*', requireAdmin)
app.use('/api/recipients/*', requireAdmin)
app.use('/api/recipient-candidates', requireAdmin)
app.use('/api/templates/*', requireAdmin)
app.use('/api/monitor/*', requireAdmin)
app.use('/api/runs/*', requireAdmin)
app.use('/api/changes', requireAdmin)
app.use('/api/wiki', requireSession)
app.use('/api/recipients', requireSession)
app.use('/api/templates', requireSession)
app.use('/api/monitor', requireSession)
app.use('/api/runs', requireSession)
app.use('/api/wiki', requireAdmin)
app.use('/api/recipients', requireAdmin)
app.use('/api/templates', requireAdmin)
app.use('/api/monitor', requireAdmin)
app.use('/api/runs', requireAdmin)
app.use('/api/wiki/*', requireCsrf)
app.use('/api/recipients/*', requireCsrf)
app.use('/api/templates/*', requireCsrf)
app.use('/api/monitor/*', requireCsrf)
app.use('/api/wiki', requireCsrf)
app.use('/api/recipients', requireCsrf)
app.use('/api/templates', requireCsrf)
app.use('/api/monitor', requireCsrf)

app.route('/api/wiki', wikiRoutes)
app.route('/api/recipients', recipientRoutes)
app.get('/api/recipient-candidates', async (c) => {
  const type = c.req.query('type') === 'chat' ? 'chat' : 'user'
  const session = c.get('session')!
  const client = new FeishuClient(c.env)
  const userToken = await getStoredUserToken(c.env, session.userId)
  const result = type === 'chat'
    ? await client.listChats(userToken.accessToken, c.req.query('cursor'))
    : await client.listUsers(userToken.accessToken, c.req.query('cursor'))
  const query = (c.req.query('query') || '').trim().toLowerCase()
  return ok(c, query ? { ...result, items: result.items.filter((item) => item.name.toLowerCase().includes(query)) } : result)
})
app.route('/api/templates', templateRoutes)
app.route('/api/monitor', monitorRoutes)
app.get('/api/runs', async (c) => ok(c, { items: await new RunRepository(c.env).list(), nextCursor: null }))
app.get('/api/runs/:runId', async (c) => {
  const run = await new RunRepository(c.env).get(c.req.param('runId'))
  if (!run) throw new AppError('NOT_FOUND', '运行记录不存在', 404)
  return ok(c, run)
})
app.get('/api/changes', async (c) => ok(c, { items: await new RunRepository(c.env).listEvents(), nextCursor: null }))

app.notFound((c) => c.json({ success: false, error: { code: 'NOT_FOUND', message: '接口不存在', requestId: c.get('requestId') } }, 404))
app.onError((error, c) => fail(c, error))

export default app
