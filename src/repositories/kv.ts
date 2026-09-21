import type { CloudflareBindings } from '../bindings'
import { AppError } from '../shared/errors'

interface ListOptions {
  prefix?: string
  cursor?: string
  limit?: number
}

interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: ListOptions): Promise<{ keys: Array<{ name: string }>; cursor?: string; list_complete: boolean }>
}

const memory = new Map<string, { value: string; expiresAt?: number }>()

const memoryKv: KVLike = {
  async get(key) {
    const entry = memory.get(key)
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      memory.delete(key)
      return null
    }
    return entry.value
  },
  async put(key, value, options) {
    memory.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined,
    })
  },
  async delete(key) {
    memory.delete(key)
  },
  async list(options = {}) {
    const keys = [...memory.keys()]
      .filter((key) => !options.prefix || key.startsWith(options.prefix))
      .slice(0, options.limit ?? 1000)
      .map((name) => ({ name }))
    return { keys, list_complete: true }
  },
}

export class KvRepository {
  private readonly kv: KVLike

  constructor(env: CloudflareBindings) {
    const origin = env.APP_ORIGIN || ''
    const isLocal = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')
    if (!env.FEISHU_MONITOR_KV && !isLocal) {
      throw new AppError('CONFIGURATION_ERROR', '生产环境缺少 FEISHU_MONITOR_KV Binding', 503)
    }
    this.kv = (env.FEISHU_MONITOR_KV as KVLike | undefined) ?? memoryKv
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.kv.get(key)
      return value ? (JSON.parse(value) as T) : null
    } catch (error) {
      throw new Error(`KV read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  async put<T>(key: string, value: T, expirationTtl?: number): Promise<void> {
    try {
      await this.kv.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined)
    } catch (error) {
      console.error(JSON.stringify({
        type: 'kv_write_failed',
        key,
        hasExpirationTtl: Boolean(expirationTtl),
        error: error instanceof Error ? error.message : String(error),
      }))
      throw new Error(`KV write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key)
    } catch (error) {
      throw new Error(`KV write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  async listValues<T>(prefix: string, limit = 1000): Promise<T[]> {
    const values: T[] = []
    let cursor: string | undefined
    do {
      const result = await this.kv.list({
        prefix,
        cursor,
        limit: Math.min(1000, Math.max(1, limit - values.length)),
      })
      for (const { name } of result.keys) {
        const value = await this.get<T>(name)
        if (value !== null) values.push(value)
        if (values.length >= limit) break
      }
      if (values.length >= limit || result.list_complete || !result.cursor) break
      cursor = result.cursor
    } while (cursor)
    return values
  }

  async listKeys(prefix: string, limit = 1000): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const result = await this.kv.list({
        prefix,
        cursor,
        limit: Math.min(1000, Math.max(1, limit - keys.length)),
      })
      keys.push(...result.keys.map(({ name }) => name))
      if (keys.length >= limit || result.list_complete || !result.cursor) break
      cursor = result.cursor
    } while (cursor)
    return keys.slice(0, limit)
  }

  /** Only used by local development and unit tests. */
  static clearMemory(): void {
    memory.clear()
  }
}
