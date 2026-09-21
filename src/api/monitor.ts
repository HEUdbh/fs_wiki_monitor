import { Hono } from 'hono'
import type { AppEnv } from '../bindings'
import { runWikiMonitor } from '../monitor/runner'
import { RunRepository } from '../repositories/runs'
import { randomId } from '../auth/crypto'
import { KvRepository } from '../repositories/kv'
import { AppError } from '../shared/errors'
import { ConfigRepository } from '../repositories/config'
import { ok } from '../shared/response'

export const monitorRoutes = new Hono<AppEnv>()

monitorRoutes.post('/run', async (c) => {
  const body: { monitorId?: string } = await c.req.json<{ monitorId?: string }>().catch(() => ({}))
  const session = c.get('session')!
  if (body.monitorId && !(await new ConfigRepository(c.env).getMonitor(body.monitorId))) {
    throw new AppError('NOT_FOUND', '监控配置不存在', 404)
  }
  const kv = new KvRepository(c.env)
  const rateKey = `rate:monitor:manual:${session.userId}`
  if (await kv.get(rateKey)) throw new AppError('RATE_LIMITED', '手动扫描请求过于频繁，请稍后再试', 429)
  // Cloudflare KV expirationTtl must be at least 60 seconds.
  await kv.put(rateKey, { createdAt: new Date().toISOString() }, 60)
  const runId = randomId('run')
  const promise = runWikiMonitor(c.env, { trigger: 'manual', monitorId: body.monitorId, runId })
  c.executionCtx.waitUntil(promise)
  return ok(c, { accepted: true, runId }, 202)
})

monitorRoutes.get('/status', async (c) => ok(c, await new RunRepository(c.env).getLatest()))
monitorRoutes.get('/runs', async (c) => ok(c, { items: await new RunRepository(c.env).list(), nextCursor: null }))
monitorRoutes.get('/changes', async (c) => ok(c, { items: await new RunRepository(c.env).listEvents(), nextCursor: null }))
