import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudflareBindings } from '../bindings'
import { encryptJson } from '../auth/crypto'
import { ConfigRepository } from '../repositories/config'
import { KvRepository } from '../repositories/kv'
import { RunRepository } from '../repositories/runs'
import type { Recipient, WikiMonitorConfig } from '../shared/types'
import { runWikiMonitor } from './runner'

const baseEnv = {
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret',
  TOKEN_ENCRYPTION_KEY: 'test-encryption-key',
} as CloudflareBindings

async function seedMonitor(recipient?: Recipient) {
  const kv = new KvRepository(baseEnv)
  const config = new ConfigRepository(baseEnv)
  const monitor: WikiMonitorConfig = {
    schemaVersion: 1,
    id: 'mon_test',
    enabled: true,
    spaceId: 'spc_test',
    spaceName: '测试知识库',
    pollIntervalMinutes: 15,
    notifyOnFirstScan: false,
    authUserId: 'user_test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await config.putMonitor(monitor)
  if (recipient) await config.putRecipient(recipient)
  await kv.put(`token:user:${monitor.authUserId}`, {
    encrypted: await encryptJson(baseEnv, {
      schemaVersion: 1,
      userId: monitor.authUserId,
      openId: 'ou_admin',
      accessToken: 'user-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: 'wiki:wiki:readonly',
    }),
  })
}

function feishu(data: unknown, status = 200) {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data }), { status })
}

describe('wiki monitor runner', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    KvRepository.clearMemory()
  })

  it('creates a baseline, detects a later edit, and remains quiet when unchanged', async () => {
    await seedMonitor()
    let editTime = '1789952400'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/nodes')) {
        return feishu(url.searchParams.has('parent_node_token')
          ? { items: [], has_more: false }
          : {
            items: [{ space_id: 'spc_test', node_token: 'wik_doc', obj_token: 'dox_doc', obj_type: 'docx', title: '设计文档', has_child: false }],
            has_more: false,
          })
      }
      if (url.pathname.endsWith('/metas/batch_query')) {
        return feishu({ metas: [{ doc_token: 'dox_doc', title: '设计文档', latest_modify_time: editTime, url: 'https://example/doc' }] })
      }
      throw new Error(`Unexpected Feishu URL: ${url}`)
    }))

    const first = await runWikiMonitor(baseEnv, { trigger: 'manual', runId: 'run_first' })
    expect(first.status).toBe('success')
    expect(first.scanned).toBe(1)
    expect(first.changed).toBe(0)

    editTime = '1789952460'
    const second = await runWikiMonitor(baseEnv, { trigger: 'manual', runId: 'run_second' })
    expect(second.changed).toBe(1)
    expect(second.notified).toBe(0)

    const third = await runWikiMonitor(baseEnv, { trigger: 'manual', runId: 'run_third' })
    expect(third.changed).toBe(0)
    await expect(new RunRepository(baseEnv).listEvents()).resolves.toHaveLength(1)
  })

  it('keeps the old snapshot after a partial notification failure and retries it', async () => {
    const recipient: Recipient = {
      schemaVersion: 1,
      id: 'recipient_test',
      type: 'user',
      openId: 'ou_recipient',
      name: '接收人',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await seedMonitor(recipient)
    let editTime = '1789952400'
    let sendAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 'tenant-token', expire: 7200 }))
      }
      if (url.pathname.endsWith('/nodes')) {
        return feishu(url.searchParams.has('parent_node_token') ? { items: [], has_more: false } : {
          items: [{ space_id: 'spc_test', node_token: 'wik_doc', obj_token: 'dox_doc', obj_type: 'docx', title: '设计文档' }],
          has_more: false,
        })
      }
      if (url.pathname.endsWith('/metas/batch_query')) {
        return feishu({ metas: [{ doc_token: 'dox_doc', title: '设计文档', latest_modify_time: editTime, url: 'https://example/doc' }] })
      }
      if (url.pathname.endsWith('/messages')) {
        sendAttempts += 1
        if (sendAttempts === 1) return new Response(JSON.stringify({ code: 999, msg: 'temporary failure' }))
        return feishu({ message_id: 'om_success' })
      }
      throw new Error(`Unexpected Feishu URL: ${url}`)
    }))

    await runWikiMonitor(baseEnv, { trigger: 'manual', runId: 'run_first' })
    editTime = '1789952460'
    const failed = await runWikiMonitor(baseEnv, { trigger: 'manual', runId: 'run_failed' })
    expect(failed.failed).toBeGreaterThan(0)

    const retried = await runWikiMonitor(baseEnv, { trigger: 'manual', runId: 'run_retry' })
    expect(retried.notified).toBe(1)
    expect(sendAttempts).toBe(2)
    const snapshot = await new KvRepository(baseEnv).get<{ lastEditTime: string }>('snapshot:mon_test:dox_doc')
    expect(snapshot?.lastEditTime).toBe(new Date(Number(editTime) * 1000).toISOString())
  })
})
