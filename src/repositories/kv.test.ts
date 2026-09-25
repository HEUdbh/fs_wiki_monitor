import { describe, expect, it } from 'vitest'
import type { CloudflareBindings } from '../bindings'
import { KvRepository } from './kv'

const localEnv = {
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
} as CloudflareBindings

describe('KvRepository pagination', () => {
  it('rejects a production environment without a KV binding', () => {
    expect(() => new KvRepository({
      ...localEnv,
      APP_ORIGIN: 'https://monitor.example.com',
      FEISHU_MONITOR_KV: undefined,
    })).toThrow('FEISHU_MONITOR_KV')
  })

  it('reads all Cloudflare KV list pages up to the requested limit', async () => {
    const values: Record<string, string> = {
      'event:1': JSON.stringify({ id: 1 }),
      'event:2': JSON.stringify({ id: 2 }),
    }
    const kv = {
      async get(key: string) { return values[key] || null },
      async put() {},
      async delete() {},
      async list(options: { cursor?: string }) {
        if (!options.cursor) return { keys: [{ name: 'event:1' }], cursor: 'next', list_complete: false }
        return { keys: [{ name: 'event:2' }], list_complete: true }
      },
    }
    const env = { FEISHU_MONITOR_KV: kv } as unknown as CloudflareBindings
    await expect(new KvRepository(env).listValues<{ id: number }>('event:')).resolves.toEqual([{ id: 1 }, { id: 2 }])
  })

  it('exposes one paginated key page for maintenance jobs', async () => {
    const kv = {
      async get() { return null },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [{ name: 'snapshot:1' }], cursor: 'next', list_complete: false }
      },
    }
    const env = { FEISHU_MONITOR_KV: kv } as unknown as CloudflareBindings
    await expect(new KvRepository(env).listKeyPage('snapshot:', undefined, 10)).resolves.toEqual({
      keys: ['snapshot:1'],
      cursor: 'next',
      listComplete: false,
    })
  })
})
