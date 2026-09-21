import { Hono } from 'hono'
import type { AppEnv } from '../bindings'
import { randomId } from '../auth/crypto'
import { ConfigRepository } from '../repositories/config'
import { AppError } from '../shared/errors'
import { ok } from '../shared/response'
import type { NotificationTemplate } from '../shared/types'
import { renderTemplate, validateTemplate } from '../monitor/template'

export const templateRoutes = new Hono<AppEnv>()

templateRoutes.get('/', async (c) => {
  const repository = new ConfigRepository(c.env)
  return ok(c, { items: await repository.listTemplates(), defaultId: await repository.getDefaultTemplateId() || 'default' })
})

templateRoutes.post('/', async (c) => {
  const body = await c.req.json<Partial<NotificationTemplate>>()
  if (!body.name?.trim() || !body.content) throw new AppError('INVALID_REQUEST', '模板名称和内容必填', 400)
  if (body.name.length > 100) throw new AppError('INVALID_REQUEST', '模板名称不能超过 100 字符', 400)
  validateTemplate(body.content)
  const now = new Date().toISOString()
  const value: NotificationTemplate = {
    schemaVersion: 1,
    id: randomId('tpl'),
    name: body.name.trim(),
    content: body.content,
    enabled: body.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
  await new ConfigRepository(c.env).putTemplate(value)
  return ok(c, value, 201)
})

templateRoutes.put('/:id', async (c) => {
  const repository = new ConfigRepository(c.env)
  const templates = await repository.listTemplates()
  const current = templates.find((template) => template.id === c.req.param('id'))
  if (!current) throw new AppError('NOT_FOUND', '模板不存在', 404)
  const body = await c.req.json<Partial<NotificationTemplate>>()
  const content = body.content ?? current.content
  validateTemplate(content)
  if (body.name !== undefined && (!body.name.trim() || body.name.length > 100)) throw new AppError('INVALID_REQUEST', '模板名称长度不正确', 400)
  const value = { ...current, name: body.name?.trim() || current.name, content, enabled: body.enabled ?? current.enabled, updatedAt: new Date().toISOString() }
  await repository.putTemplate(value)
  return ok(c, value)
})

templateRoutes.delete('/:id', async (c) => {
  const repository = new ConfigRepository(c.env)
  const currentDefault = await repository.getDefaultTemplateId()
  if (currentDefault === c.req.param('id')) throw new AppError('INVALID_REQUEST', '不能删除默认模板，请先切换默认模板', 409)
  if (!(await repository.getTemplate(c.req.param('id')))) throw new AppError('NOT_FOUND', '模板不存在', 404)
  await repository.deleteTemplate(c.req.param('id'))
  return ok(c, { deleted: true })
})

templateRoutes.post('/:id/preview', async (c) => {
  const repository = new ConfigRepository(c.env)
  const template = (await repository.listTemplates()).find((item) => item.id === c.req.param('id'))
  if (!template) throw new AppError('NOT_FOUND', '模板不存在', 404)
  const body = await c.req.json<{ variables?: Record<string, string> }>().catch(() => ({ variables: {} }))
  return ok(c, { content: renderTemplate(template.content, {
    document_title: 'API 网关设计',
    wiki_name: '研发知识库',
    updated_at: '2026-09-21 13:30:00',
    editor_name: '张三',
    editor_id: 'ou_example',
    document_url: 'https://example.feishu.cn/wiki/wikcnExample',
    ...body.variables,
  }) })
})

templateRoutes.post('/:id/set-default', async (c) => {
  const repository = new ConfigRepository(c.env)
  const template = await repository.getTemplate(c.req.param('id'))
  if (!template) throw new AppError('NOT_FOUND', '模板不存在', 404)
  if (!template.enabled) throw new AppError('INVALID_REQUEST', '不能将禁用模板设为默认模板', 400)
  await repository.setDefaultTemplateId(c.req.param('id'))
  return ok(c, { defaultId: c.req.param('id') })
})
