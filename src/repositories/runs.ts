import type { CloudflareBindings } from '../bindings'
import type { DocumentChangeEvent, RunSummary } from '../shared/types'
import { KvRepository } from './kv'

export class RunRepository {
  private readonly kv: KvRepository

  constructor(env: CloudflareBindings) {
    this.kv = new KvRepository(env)
  }

  private putRecord(run: RunSummary): Promise<void> {
    return this.kv.put(`run:${run.runId}`, run, 60 * 60 * 24 * 30)
  }

  async put(run: RunSummary): Promise<void> {
    await this.putRecord(run)
    await this.kv.put('run:latest', run)
  }

  getLatest() {
    return this.kv.get<RunSummary>('run:latest')
  }

  get(runId: string) {
    return this.kv.get<RunSummary>(`run:${runId}`)
  }

  async list(): Promise<RunSummary[]> {
    const values = await this.kv.listValues<RunSummary>('run:')
    const unique = new Map<string, RunSummary>()
    for (const run of values) {
      if (!run.runId) continue
      const previous = unique.get(run.runId)
      if (!previous || run.startedAt > previous.startedAt) unique.set(run.runId, run)
    }
    return [...unique.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100)
  }

  async markStaleRunning(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs
    const stale = (await this.list()).filter((run) => (
      run.status === 'running' && new Date(run.startedAt).getTime() < cutoff
    ))
    for (const run of stale) {
      await this.putRecord({
        ...run,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        failed: run.failed + 1,
        errors: [
          ...run.errors,
          { code: 'INTERNAL_ERROR', message: '任务超过锁租期仍未完成，可能被 Worker 执行时限终止' },
        ],
      })
    }
  }

  async markLatestStaleRunning(maxAgeMs: number): Promise<void> {
    const run = await this.getLatest()
    if (!run || run.status !== 'running') return
    if (new Date(run.startedAt).getTime() >= Date.now() - maxAgeMs) return
    await this.put({
      ...run,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      failed: run.failed + 1,
      errors: [
        ...run.errors,
        { code: 'INTERNAL_ERROR', message: '任务超过锁租期仍未完成，可能被 Worker 执行时限终止' },
      ],
    })
  }

  putEvent(event: DocumentChangeEvent) {
    return this.kv.put(`event:${event.eventId}`, event, 60 * 60 * 24 * 90)
  }

  getEvent(eventId: string) {
    return this.kv.get<DocumentChangeEvent>(`event:${eventId}`)
  }

  async listEvents(): Promise<DocumentChangeEvent[]> {
    const values = await this.kv.listValues<DocumentChangeEvent>('event:')
    return values.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)).slice(0, 500)
  }
}
