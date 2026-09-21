import { Hono } from 'hono'
import type { AppEnv } from '../bindings'
import { getStoredUserToken } from '../auth/oauth'
import { randomId } from '../auth/crypto'
import { FeishuClient } from '../feishu/client'
import { ConfigRepository } from '../repositories/config'
import { AppError } from '../shared/errors'
import { ok } from '../shared/response'
import type { WikiMonitorConfig } from '../shared/types'

export const wikiRoutes = new Hono<AppEnv>()

function pollInterval(value: unknown): number {
  const parsed = value === undefined ? 15 : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
    throw new AppError('INVALID_REQUEST', 'pollIntervalMinutes 必须是 1-1440 的整数', 400)
  }
  return parsed
}

wikiRoutes.get('/spaces', async (c) => {
  const session = c.get('session')!
  const userToken = await getStoredUserToken(c.env, session.userId)
  const client = new FeishuClient(c.env)
  const items = []
  let cursor = c.req.query('cursor') || undefined
  let pageCount = 0
  do {
    const page = await client.listSpaces(userToken.accessToken, cursor)
    items.push(...page.items)
    cursor = page.nextCursor || undefined
    pageCount += 1
  } while (cursor && pageCount < 20)
  return ok(c, { items, nextCursor: cursor || null })
})

wikiRoutes.get('/spaces/:spaceId/tree', async (c) => {
  const session = c.get('session')!
  const userToken = await getStoredUserToken(c.env, session.userId)
  const client = new FeishuClient(c.env)
  return ok(c, await client.listWikiChildren(
    userToken.accessToken,
    c.req.param('spaceId'),
    c.req.query('parentNodeToken'),
    c.req.query('cursor'),
  ))
})

wikiRoutes.get('/monitors', async (c) => ok(c, await new ConfigRepository(c.env).listMonitors()))

wikiRoutes.post('/monitors', async (c) => {
  const body = await c.req.json<Partial<WikiMonitorConfig>>()
  const requestedPollInterval = pollInterval(body.pollIntervalMinutes)
  if (!body.spaceId || !/^[A-Za-z0-9_-]{1,200}$/.test(body.spaceId)) {
    throw new AppError('INVALID_REQUEST', 'spaceId 格式不正确', 400)
  }
  const session = c.get('session')!
  const userToken = await getStoredUserToken(c.env, session.userId)
  const client = new FeishuClient(c.env)
  const space = await client.getWikiSpace(userToken.accessToken, body.spaceId)
  let rootNodeTitle = body.rootNodeTitle
  if (body.rootNodeToken) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(body.rootNodeToken)) throw new AppError('INVALID_REQUEST', 'rootNodeToken 格式不正确', 400)
    const root = await client.getWikiNode(userToken.accessToken, body.rootNodeToken)
    if (root.spaceId !== space.spaceId) throw new AppError('INVALID_REQUEST', '根节点不属于所选知识库', 400)
    rootNodeTitle = root.title
  }
  const existing = await new ConfigRepository(c.env).listMonitors()
  if (existing.some((monitor) => monitor.spaceId === space.spaceId && monitor.rootNodeToken === body.rootNodeToken)) {
    throw new AppError('INVALID_REQUEST', '该知识库监控已存在', 409)
  }
  const now = new Date().toISOString()
  const value: WikiMonitorConfig = {
    schemaVersion: 1,
    id: randomId('mon'),
    enabled: body.enabled ?? true,
    spaceId: body.spaceId,
    spaceName: space.name,
    rootNodeToken: body.rootNodeToken,
    rootNodeTitle,
    pollIntervalMinutes: requestedPollInterval,
    notifyOnFirstScan: body.notifyOnFirstScan ?? false,
    authUserId: c.get('session')!.userId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  await new ConfigRepository(c.env).putMonitor(value)
  return ok(c, value, 201)
})

wikiRoutes.put('/monitors/:id', async (c) => {
  const repository = new ConfigRepository(c.env)
  const current = await repository.getMonitor(c.req.param('id'))
  if (!current) throw new AppError('NOT_FOUND', '监控配置不存在', 404)
  const body = await c.req.json<Partial<WikiMonitorConfig>>()
  const session = c.get('session')!
  const userToken = await getStoredUserToken(c.env, session.userId)
  const client = new FeishuClient(c.env)
  let rootNodeTitle = current.rootNodeTitle
  if (body.rootNodeToken !== undefined && body.rootNodeToken !== current.rootNodeToken) {
    if (body.rootNodeToken && !/^[A-Za-z0-9_-]{1,200}$/.test(body.rootNodeToken)) throw new AppError('INVALID_REQUEST', 'rootNodeToken 格式不正确', 400)
    if (body.rootNodeToken) {
      const root = await client.getWikiNode(userToken.accessToken, body.rootNodeToken)
      if (root.spaceId !== current.spaceId) throw new AppError('INVALID_REQUEST', '根节点不属于所选知识库', 400)
      rootNodeTitle = root.title
    } else {
      rootNodeTitle = undefined
    }
  }
  const value: WikiMonitorConfig = {
    ...current,
    enabled: body.enabled ?? current.enabled,
    spaceName: body.spaceName || current.spaceName,
    rootNodeToken: body.rootNodeToken === undefined ? current.rootNodeToken : body.rootNodeToken,
    rootNodeTitle,
    pollIntervalMinutes: body.pollIntervalMinutes === undefined
      ? (current.pollIntervalMinutes || 15)
      : pollInterval(body.pollIntervalMinutes),
    notifyOnFirstScan: body.notifyOnFirstScan ?? current.notifyOnFirstScan,
    updatedAt: new Date().toISOString(),
  }
  await repository.putMonitor(value)
  return ok(c, value)
})

wikiRoutes.delete('/monitors/:id', async (c) => {
  await new ConfigRepository(c.env).deleteMonitor(c.req.param('id'))
  return ok(c, { deleted: true })
})
