import type { CloudflareBindings } from '../bindings'
import type { NotificationTemplate, Recipient, WikiMonitorConfig } from '../shared/types'
import { KvRepository } from './kv'

export const DEFAULT_TEMPLATE_ID = 'default'
export const DEFAULT_TEMPLATE_CONTENT = `[飞书知识库更新提醒]

文档：{{document_title}}
知识库：{{wiki_name}}
更新时间：{{updated_at}}
操作人：{{editor_name}}
链接：{{document_url}}`

export class ConfigRepository {
  private readonly kv: KvRepository

  constructor(env: CloudflareBindings) {
    this.kv = new KvRepository(env)
  }

  listMonitors() {
    return this.kv.listValues<WikiMonitorConfig>('config:monitor:')
  }

  getMonitor(id: string) {
    return this.kv.get<WikiMonitorConfig>(`config:monitor:${id}`)
  }

  putMonitor(value: WikiMonitorConfig) {
    return this.kv.put(`config:monitor:${value.id}`, value)
  }

  async updateMonitorStatus(id: string, status: WikiMonitorConfig['status']): Promise<void> {
    const current = await this.getMonitor(id)
    if (!current || current.status === status) return
    await this.putMonitor({ ...current, status, updatedAt: new Date().toISOString() })
  }

  deleteMonitor(id: string) {
    return this.kv.delete(`config:monitor:${id}`)
  }

  listRecipients() {
    return this.kv.listValues<Recipient>('config:recipient:')
  }

  putRecipient(value: Recipient) {
    return this.kv.put(`config:recipient:${value.id}`, value)
  }

  getRecipient(id: string) {
    return this.kv.get<Recipient>(`config:recipient:${id}`)
  }

  deleteRecipient(id: string) {
    return this.kv.delete(`config:recipient:${id}`)
  }

  async listTemplates(): Promise<NotificationTemplate[]> {
    const templates = await this.kv.listValues<NotificationTemplate>('config:template:')
    if (templates.length > 0) return templates
    const now = new Date().toISOString()
    const template: NotificationTemplate = {
      schemaVersion: 1,
      id: DEFAULT_TEMPLATE_ID,
      name: '默认更新提醒',
      enabled: true,
      content: DEFAULT_TEMPLATE_CONTENT,
      createdAt: now,
      updatedAt: now,
    }
    await this.putTemplate(template)
    return [template]
  }

  putTemplate(value: NotificationTemplate) {
    return this.kv.put(`config:template:${value.id}`, value)
  }

  getTemplate(id: string) {
    return this.kv.get<NotificationTemplate>(`config:template:${id}`)
  }

  deleteTemplate(id: string) {
    return this.kv.delete(`config:template:${id}`)
  }

  getDefaultTemplateId() {
    return this.kv.get<string>('config:template-default')
  }

  setDefaultTemplateId(id: string) {
    return this.kv.put('config:template-default', id)
  }
}
