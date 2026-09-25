import { afterEach, describe, expect, it } from 'vitest'
import type { CloudflareBindings } from '../bindings'
import type { DocumentSnapshot, RunSummary, WikiMonitorConfig } from '../shared/types'
import { KvRepository } from '../repositories/kv'
import { cleanupKvData } from './cleanup'

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
} as CloudflareBindings

const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()

function snapshot(status: DocumentSnapshot['status'], monitorId: string): DocumentSnapshot {
  return {
    schemaVersion: 1,
    monitorId,
    documentToken: `doc_${monitorId}`,
    wikiNodeToken: `node_${monitorId}`,
    spaceId: 'space_test',
    title: '文档',
    url: 'https://example.test/doc',
    lastEditTime: oldDate,
    lastCheckedAt: oldDate,
    status,
  }
}

function run(runId: string): RunSummary {
  return {
    schemaVersion: 1,
    runId,
    trigger: 'cron',
    startedAt: oldDate,
    finishedAt: oldDate,
    status: 'success',
    scanned: 0,
    changed: 0,
    notified: 0,
    failed: 0,
    errors: [],
  }
}

afterEach(() => KvRepository.clearMemory())

describe('KV cleanup', () => {
  it('removes old runs, removed snapshots, and orphan snapshots while preserving active data', async () => {
    const kv = new KvRepository(env)
    const monitor: WikiMonitorConfig = {
      schemaVersion: 1,
      id: 'mon_keep',
      enabled: true,
      spaceId: 'space_test',
      spaceName: '测试知识库',
      pollIntervalMinutes: 30,
      notifyOnFirstScan: false,
      authUserId: 'user_test',
      status: 'active',
      createdAt: oldDate,
      updatedAt: oldDate,
    }
    await kv.put('config:monitor:mon_keep', monitor)
    await kv.put('run:old', run('old'))
    await kv.put('run:latest', { ...run('latest'), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })
    await kv.put('snapshot:mon_keep:removed', snapshot('removed', 'mon_keep'))
    await kv.put('snapshot:mon_keep:active', snapshot('active', 'mon_keep'))
    await kv.put('snapshot:mon_gone:orphan', snapshot('active', 'mon_gone'))

    const result = await cleanupKvData(env)

    expect(result.deleted).toBe(3)
    await expect(kv.get('run:old')).resolves.toBeNull()
    await expect(kv.get('run:latest')).resolves.not.toBeNull()
    await expect(kv.get('snapshot:mon_keep:removed')).resolves.toBeNull()
    await expect(kv.get('snapshot:mon_keep:active')).resolves.not.toBeNull()
    await expect(kv.get('snapshot:mon_gone:orphan')).resolves.toBeNull()
  })

  it('limits one cleanup run to 500 deletions and continues on the next run', async () => {
    const kv = new KvRepository(env)
    for (let index = 0; index < 600; index += 1) {
      await kv.put(`snapshot:gone_${String(index).padStart(3, '0')}:doc`, snapshot('active', `gone_${index}`))
    }

    const first = await cleanupKvData(env)
    expect(first.deleted).toBe(500)
    const second = await cleanupKvData(env)
    expect(second.deleted).toBe(100)
    await expect(kv.listKeys('snapshot:')).resolves.toHaveLength(0)
  })
})
