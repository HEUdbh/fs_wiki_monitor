import type { CloudflareBindings } from '../bindings'
import type { DocumentChangeEvent, RunSummary } from '../shared/types'
import { KvRepository } from './kv'

export class RunRepository {
  private readonly kv: KvRepository

  constructor(env: CloudflareBindings) {
    this.kv = new KvRepository(env)
  }

  async put(run: RunSummary): Promise<void> {
    await this.kv.put(`run:${run.runId}`, run, 60 * 60 * 24 * 30)
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
