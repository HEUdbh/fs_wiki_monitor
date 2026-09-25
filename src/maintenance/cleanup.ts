import type { CloudflareBindings } from '../bindings'
import type { DocumentSnapshot, RunSummary, WikiMonitorConfig } from '../shared/types'
import { randomId } from '../auth/crypto'
import { MonitorLock } from '../monitor/lock'
import { ConfigRepository } from '../repositories/config'
import { KvRepository } from '../repositories/kv'
import { RunRepository } from '../repositories/runs'

export const CLEANUP_BATCH_SIZE = 500
export const DATA_RETENTION_DAYS = 30
export const DATA_RETENTION_SECONDS = DATA_RETENTION_DAYS * 24 * 60 * 60

const RUN_CURSOR_KEY = 'maintenance:cleanup:cursor:run'
const SNAPSHOT_CURSOR_KEY = 'maintenance:cleanup:cursor:snapshot'

export interface CleanupResult {
  deleted: number
  inspected: number
  remaining: number
}

function isOlderThan(value: string | undefined, cutoff: number): boolean {
  if (!value) return false
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) && timestamp < cutoff
}

function monitorIdFromSnapshotKey(key: string): string | undefined {
  const [, monitorId] = key.split(':', 2)
  return monitorId || undefined
}

async function cleanupRuns(kv: KvRepository, cutoff: number, remaining: number): Promise<CleanupResult> {
  if (remaining <= 0) return { deleted: 0, inspected: 0, remaining: 0 }
  const cursor = (await kv.get<string>(RUN_CURSOR_KEY)) || undefined
  const page = await kv.listKeyPage('run:', cursor, Math.max(1, remaining))
  let deleted = 0
  let inspected = 0
  for (const key of page.keys) {
    if (key === 'run:latest') continue
    const run = await kv.get<RunSummary>(key)
    inspected += 1
    if (run && isOlderThan(run.finishedAt || run.startedAt, cutoff)) {
      await kv.delete(key)
      deleted += 1
    }
  }
  if (page.listComplete) await kv.delete(RUN_CURSOR_KEY)
  else if (page.cursor) await kv.put(RUN_CURSOR_KEY, page.cursor)
  return { deleted, inspected, remaining: remaining - deleted }
}

async function cleanupSnapshots(
  kv: KvRepository,
  monitorIds: Set<string>,
  cutoff: number,
  remaining: number,
): Promise<CleanupResult> {
  if (remaining <= 0) return { deleted: 0, inspected: 0, remaining: 0 }
  const cursor = (await kv.get<string>(SNAPSHOT_CURSOR_KEY)) || undefined
  const page = await kv.listKeyPage('snapshot:', cursor, Math.max(1, remaining))
  let deleted = 0
  let inspected = 0
  for (const key of page.keys) {
    const snapshot = await kv.get<DocumentSnapshot>(key)
    inspected += 1
    if (!snapshot || !isOlderThan(snapshot.lastCheckedAt, cutoff)) continue
    const monitorId = monitorIdFromSnapshotKey(key)
    const orphaned = Boolean(monitorId && !monitorIds.has(monitorId))
    if (snapshot.status === 'removed' || orphaned) {
      await kv.delete(key)
      deleted += 1
    }
  }
  if (page.listComplete) await kv.delete(SNAPSHOT_CURSOR_KEY)
  else if (page.cursor) await kv.put(SNAPSHOT_CURSOR_KEY, page.cursor)
  return { deleted, inspected, remaining: remaining - deleted }
}

export async function cleanupKvData(env: CloudflareBindings): Promise<CleanupResult> {
  const kv = new KvRepository(env)
  const runs = new RunRepository(env)
  const configs = new ConfigRepository(env)
  const lock = new MonitorLock(env)
  const lockRunId = randomId('cleanup')
  if (!(await lock.tryAcquire(lockRunId))) {
    return { deleted: 0, inspected: 0, remaining: CLEANUP_BATCH_SIZE }
  }
  const lockTtlSeconds = Math.max(60, Number(env.MONITOR_LOCK_TTL_SECONDS || 600))
  try {
    await runs.markStaleRunning(lockTtlSeconds * 1000)
    const monitors = await configs.listMonitors() as WikiMonitorConfig[]
    const cutoff = Date.now() - DATA_RETENTION_SECONDS * 1000
    const runResult = await cleanupRuns(kv, cutoff, CLEANUP_BATCH_SIZE)
    const snapshotResult = await cleanupSnapshots(kv, new Set(monitors.map((monitor) => monitor.id)), cutoff, runResult.remaining)
    const result = {
      deleted: runResult.deleted + snapshotResult.deleted,
      inspected: runResult.inspected + snapshotResult.inspected,
      remaining: snapshotResult.remaining,
    }
    console.info(JSON.stringify({ type: 'kv_cleanup_completed', ...result }))
    return result
  } finally {
    await lock.release(lockRunId)
  }
}
