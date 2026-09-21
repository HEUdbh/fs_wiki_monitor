import { Hono } from 'hono'
import type { AppEnv } from '../bindings'
import { randomId } from '../auth/crypto'
import { FeishuClient } from '../feishu/client'
import { ConfigRepository } from '../repositories/config'
import { AppError } from '../shared/errors'
import { ok } from '../shared/response'
import type { Recipient } from '../shared/types'

export const recipientRoutes = new Hono<AppEnv>()

recipientRoutes.get('/candidates', async (c) => {
  const type = c.req.query('type') === 'chat' ? 'chat' : 'user'
  const client = new FeishuClient(c.env)
  const token = await client.getTenantAccessToken()
  const result = type === 'chat'
    ? await client.listChats(token, c.req.query('cursor'))
    : await client.listUsers(token, c.req.query('cursor'))
  const query = (c.req.query('query') || '').trim().toLowerCase()
  return ok(c, query ? { ...result, items: result.items.filter((item) => item.name.toLowerCase().includes(query)) } : result)
})

recipientRoutes.get('/', async (c) => ok(c, await new ConfigRepository(c.env).listRecipients()))

recipientRoutes.post('/', async (c) => {
  const body = await c.req.json<Partial<Recipient>>()
  if (!body.type || !['user', 'chat'].includes(body.type)) throw new AppError('INVALID_REQUEST', '接收人类型不正确', 400)
  if (body.type === 'user' && !body.openId) throw new AppError('INVALID_REQUEST', '用户接收人缺少 openId', 400)
  if (body.type === 'chat' && !body.chatId) throw new AppError('INVALID_REQUEST', '群接收人缺少 chatId', 400)
  const targetId = body.type === 'user' ? body.openId! : body.chatId!
  if (!/^[A-Za-z0-9_:-]{1,200}$/.test(targetId)) throw new AppError('INVALID_REQUEST', '接收人 ID 格式不正确', 400)
  const client = new FeishuClient(c.env)
  const token = await client.getTenantAccessToken()
  const canonical = body.type === 'user'
    ? await client.getUser(token, body.openId!)
    : await client.getChat(token, body.chatId!)
  const existing = await new ConfigRepository(c.env).listRecipients()
  if (existing.some((item) => item.type === body.type && (body.type === 'user' ? item.openId === body.openId : item.chatId === body.chatId))) {
    throw new AppError('INVALID_REQUEST', '该接收人已存在', 409)
  }
  const now = new Date().toISOString()
  const value: Recipient = {
    schemaVersion: 1,
    id: randomId('rcp'),
    type: body.type,
    openId: body.openId,
    chatId: body.chatId,
    name: canonical.name,
    enabled: body.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
  await new ConfigRepository(c.env).putRecipient(value)
  return ok(c, value, 201)
})

recipientRoutes.put('/:id', async (c) => {
  const repository = new ConfigRepository(c.env)
  const recipients = await repository.listRecipients()
  const current = recipients.find((recipient) => recipient.id === c.req.param('id'))
  if (!current) throw new AppError('NOT_FOUND', '接收人不存在', 404)
  const body = await c.req.json<Partial<Recipient>>()
  const value = { ...current, enabled: body.enabled ?? current.enabled, name: body.name || current.name, updatedAt: new Date().toISOString() }
  await repository.putRecipient(value)
  return ok(c, value)
})

recipientRoutes.delete('/:id', async (c) => {
  await new ConfigRepository(c.env).deleteRecipient(c.req.param('id'))
  return ok(c, { deleted: true })
})
