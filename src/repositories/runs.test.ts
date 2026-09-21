import { afterEach, describe, expect, it } from 'vitest'
import type { CloudflareBindings } from '../bindings'
import type { RunSummary } from '../shared/types'
import { KvRepository } from './kv'
import { RunRepository } from './runs'

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
} as CloudflareBindings

function run(runId: string, startedAt: string): RunSummary {
  return {
    schemaVersion: 1,
    runId,
    trigger: 'manual',
    startedAt,
    finishedAt: startedAt,
    status: 'success',
    scanned: 1,
    changed: 0,
    notified: 0,
    failed: 0,
    errors: [],
  }
}

describe('RunRepository', () => {
  afterEach(() => KvRepository.clearMemory())

  it('does not expose run:latest as a duplicate history item', async () => {
    const repository = new RunRepository(env)
    await repository.put(run('run_1', '2026-09-21T00:00:00.000Z'))
    await repository.put(run('run_2', '2026-09-21T00:01:00.000Z'))

    const history = await repository.list()
    expect(history.map((item) => item.runId)).toEqual(['run_2', 'run_1'])
  })
})
