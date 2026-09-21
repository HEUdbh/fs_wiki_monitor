import type { CloudflareBindings } from '../bindings'
import type {
  DocumentChangeEvent,
  DocumentMeta,
  DocumentSnapshot,
  NotificationTemplate,
  Recipient,
  RunSummary,
  WikiMonitorConfig,
  WikiNode,
} from '../shared/types'
import { toAppError } from '../shared/errors'
import { randomId, sha256 } from '../auth/crypto'
import { getStoredUserToken } from '../auth/oauth'
import { FeishuClient } from '../feishu/client'
import { ConfigRepository } from '../repositories/config'
import { KvRepository } from '../repositories/kv'
import { RunRepository } from '../repositories/runs'
import { MonitorLock } from './lock'
import { renderTemplate } from './template'
import { traverseWiki } from './traverse'

export interface MonitorRunInput {
  trigger: 'cron' | 'manual'
  monitorId?: string
  runId?: string
}

function isoFromSeconds(value: string): string {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`非法秒级时间戳：${value}`)
  return new Date(seconds * 1000).toISOString()
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function mapWithConcurrency<T>(values: T[], concurrency: number, fn: (value: T) => Promise<void>) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++]
      await fn(current)
    }
  })
  await Promise.all(workers)
}

function snapshotKey(monitorId: string, documentToken: string) {
  return `snapshot:${monitorId}:${documentToken}`
}

async function resolveEditorName(
  env: CloudflareBindings,
  client: FeishuClient,
  token: string,
  openId?: string,
): Promise<string | undefined> {
  if (!openId) return undefined
  const kv = new KvRepository(env)
  const cached = await kv.get<{ name: string }>(`user:${openId}`)
  if (cached) return cached.name
  try {
    const user = await client.getUser(token, openId)
    await kv.put(`user:${openId}`, user, 60 * 60 * 24)
    return user.name
  } catch {
    return openId
  }
}

async function buildEvent(
  monitor: WikiMonitorConfig,
  node: WikiNode,
  meta: DocumentMeta,
  previous: DocumentSnapshot,
  editorName?: string,
): Promise<DocumentChangeEvent> {
  const updatedAt = isoFromSeconds(meta.latestModifyTime)
  const eventId = (await sha256(`${monitor.id}:${meta.documentToken}:${updatedAt}`)).slice(0, 40)
  return {
    schemaVersion: 1,
    eventId,
    monitorId: monitor.id,
    spaceId: monitor.spaceId,
    wikiName: monitor.spaceName,
    documentToken: meta.documentToken,
    wikiNodeToken: node.nodeToken,
    documentTitle: meta.title || node.title,
    documentUrl: meta.url,
    previousEditTime: previous.lastEditTime,
    updatedAt,
    editorId: meta.latestModifyUser,
    editorName,
    detectedAt: new Date().toISOString(),
  }
}

async function dispatchEvent(
  env: CloudflareBindings,
  client: FeishuClient,
  token: string | undefined,
  event: DocumentChangeEvent,
  recipients: Recipient[],
  template: NotificationTemplate,
): Promise<{ notified: number; failed: number }> {
  const kv = new KvRepository(env)
  let notified = 0
  let failed = 0
  await mapWithConcurrency(recipients, 3, async (recipient) => {
    const idempotencyKey = `notify:${event.eventId}:${recipient.id}:${template.id}`
    if (await kv.get(idempotencyKey)) return
    try {
      if (!token) throw new Error('缺少消息发送凭证')
      const body = renderTemplate(template.content, {
        document_title: event.documentTitle,
        document_url: event.documentUrl,
        updated_at: new Date(event.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        editor_name: event.editorName || event.editorId || '未知',
        editor_id: event.editorId,
        wiki_name: event.wikiName,
      })
      const uuid = (await sha256(`${event.eventId}:${recipient.id}:${template.id}`)).slice(0, 50)
      const messageId = await client.sendMessage(token, recipient, body, uuid)
      await kv.put(idempotencyKey, { messageId, sentAt: new Date().toISOString() }, 60 * 60 * 24 * 90)
      notified += 1
    } catch {
      failed += 1
    }
  })
  return { notified, failed }
}

async function scanMonitor(
  env: CloudflareBindings,
  client: FeishuClient,
  readToken: string,
  notificationToken: string | undefined,
  monitor: WikiMonitorConfig,
  recipients: Recipient[],
  template: NotificationTemplate,
  run: RunSummary,
): Promise<void> {
  const kv = new KvRepository(env)
  const runs = new RunRepository(env)
  const nodes = await traverseWiki(client, readToken, monitor)
  const documents = nodes.filter((node) => node.objType === 'docx')
  const nodeByToken = new Map(documents.map((node) => [node.objToken, node]))
  const currentDocumentTokens = new Set(documents.map((node) => node.objToken))

  for (const batch of chunks(documents, 200)) {
    const query = await client.batchQueryDocumentMeta(readToken, batch.map((node) => node.objToken))
    run.failed += query.failed.length
    for (const failedToken of query.failed) {
      run.errors.push({ code: 'DOCUMENT_METADATA_FAILED', message: '无法读取文档元数据', documentToken: failedToken })
      const previous = await kv.get<DocumentSnapshot>(snapshotKey(monitor.id, failedToken))
      if (previous) {
        await kv.put(snapshotKey(monitor.id, failedToken), {
          ...previous,
          status: 'error',
          lastCheckedAt: new Date().toISOString(),
        })
      }
    }

    for (const meta of query.metas) {
      try {
        const node = nodeByToken.get(meta.documentToken)
        if (!node) continue
        run.scanned += 1
        const key = snapshotKey(monitor.id, meta.documentToken)
        const previous = await kv.get<DocumentSnapshot>(key)
        const lastEditTime = isoFromSeconds(meta.latestModifyTime)
        const editorName = await resolveEditorName(env, client, readToken, meta.latestModifyUser)
        const snapshot: DocumentSnapshot = {
          schemaVersion: 1,
          monitorId: monitor.id,
          documentToken: meta.documentToken,
          wikiNodeToken: node.nodeToken,
          spaceId: monitor.spaceId,
          title: meta.title || node.title,
          url: meta.url,
          lastEditTime,
          lastEditorId: meta.latestModifyUser,
          lastEditorName: editorName,
          lastCheckedAt: new Date().toISOString(),
          status: 'active',
        }
        if (!previous) {
          if (!monitor.notifyOnFirstScan) {
            await kv.put(key, snapshot)
            continue
          }
        } else if (previous.lastEditTime === lastEditTime || lastEditTime < previous.lastEditTime) {
          await kv.put(key, snapshot)
          continue
        }

        const baseline = previous || { ...snapshot, lastEditTime: '' }
        const event = await buildEvent(monitor, node, meta, baseline, editorName)
        const existingEvent = await runs.getEvent(event.eventId)
        if (!existingEvent) {
          await runs.putEvent(event)
          run.changed += 1
        }
        const dispatch = await dispatchEvent(env, client, notificationToken, event, recipients, template)
        run.notified += dispatch.notified
        run.failed += dispatch.failed
        if (dispatch.failed) {
          run.errors.push({ code: 'MESSAGE_SEND_FAILED', message: `${dispatch.failed} 个接收人发送失败`, documentToken: meta.documentToken })
        } else {
          await kv.put(key, snapshot)
        }
      } catch (error) {
        const appError = toAppError(error)
        run.failed += 1
        run.errors.push({ code: appError.code, message: appError.message, documentToken: meta.documentToken })
      }
    }
  }

  // Only mark removals after a complete traversal and all metadata pages succeeded.
  const previousSnapshots = await kv.listValues<DocumentSnapshot>(`snapshot:${monitor.id}:`, 10_000)
  for (const previous of previousSnapshots) {
    if (previous.status !== 'removed' && !currentDocumentTokens.has(previous.documentToken)) {
      await kv.put(snapshotKey(monitor.id, previous.documentToken), {
        ...previous,
        status: 'removed',
        lastCheckedAt: new Date().toISOString(),
      })
    }
  }
}

export async function runWikiMonitor(env: CloudflareBindings, input: MonitorRunInput): Promise<RunSummary> {
  const runs = new RunRepository(env)
  const run: RunSummary = {
    schemaVersion: 1,
    runId: input.runId || randomId('run'),
    trigger: input.trigger,
    startedAt: new Date().toISOString(),
    status: 'running',
    scanned: 0,
    changed: 0,
    notified: 0,
    failed: 0,
    errors: [],
  }
  await runs.put(run)
  const lock = new MonitorLock(env)
  if (!(await lock.tryAcquire(run.runId))) {
    run.status = 'skipped'
    run.finishedAt = new Date().toISOString()
    run.errors.push({ code: 'MONITOR_LOCKED', message: '已有扫描任务正在运行' })
    await runs.put(run)
    return run
  }

  try {
    const configs = new ConfigRepository(env)
    let monitors = (await configs.listMonitors()).filter((monitor) => monitor.enabled)
    if (input.monitorId) monitors = monitors.filter((monitor) => monitor.id === input.monitorId)
    const recipients = (await configs.listRecipients()).filter((recipient) => recipient.enabled)
    const templates = (await configs.listTemplates()).filter((template) => template.enabled)
    const defaultId = await configs.getDefaultTemplateId()
    const template = templates.find((item) => item.id === defaultId) || templates[0]
    if (!template) throw new Error('没有可用的通知模板')

    const client = new FeishuClient(env)
    let notificationToken: string | undefined
    if (recipients.length > 0) {
      try {
        notificationToken = await client.getTenantAccessToken()
      } catch (error) {
        const appError = toAppError(error)
        run.failed += 1
        run.errors.push({ code: 'MESSAGE_SEND_FAILED', message: appError.message })
      }
    }
    for (const monitor of monitors) {
      try {
        const readToken = await getStoredUserToken(env, monitor.authUserId)
        await scanMonitor(env, client, readToken.accessToken, notificationToken, monitor, recipients, template, run)
        await configs.updateMonitorStatus(monitor.id, 'active')
      } catch (error) {
        const appError = toAppError(error)
        if (appError.code === 'AUTH_REQUIRED' || appError.code === 'AUTH_EXPIRED') {
          await configs.updateMonitorStatus(monitor.id, 'auth_required')
        } else if (appError.code === 'FEISHU_PERMISSION_DENIED') {
          await configs.updateMonitorStatus(monitor.id, 'error')
        }
        run.failed += 1
        run.errors.push({ code: appError.code, message: `${monitor.spaceName}: ${appError.message}` })
      }
    }
    run.status = run.errors.length === 0 ? 'success' : run.scanned > 0 ? 'partial' : 'failed'
  } catch (error) {
    const appError = toAppError(error)
    run.failed += 1
    run.status = 'failed'
    run.errors.push({ code: appError.code, message: appError.message })
  } finally {
    run.finishedAt = new Date().toISOString()
    await runs.put(run)
    await lock.release(run.runId)
  }
  return run
}
