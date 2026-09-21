import type { CloudflareBindings } from '../bindings'
import { KvRepository } from '../repositories/kv'

interface MonitorLease {
  runId: string
  acquiredAt: string
  expiresAt: string
}

const LOCK_KEY = 'lock:monitor'

export class MonitorLock {
  private readonly kv: KvRepository

  constructor(private readonly env: CloudflareBindings) {
    this.kv = new KvRepository(env)
  }

  async tryAcquire(runId: string): Promise<boolean> {
    const existing = await this.kv.get<MonitorLease>(LOCK_KEY)
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) return false
    const ttl = Number(this.env.MONITOR_LOCK_TTL_SECONDS || 600)
    const lease: MonitorLease = {
      runId,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    }
    await this.kv.put(LOCK_KEY, lease, ttl)
    const confirmed = await this.kv.get<MonitorLease>(LOCK_KEY)
    return confirmed?.runId === runId
  }

  async release(runId: string): Promise<void> {
    const current = await this.kv.get<MonitorLease>(LOCK_KEY)
    if (current?.runId === runId) await this.kv.delete(LOCK_KEY)
  }
}
