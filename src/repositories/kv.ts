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

export interface KvKeyPage {
  keys: string[]
  cursor?: string
  listComplete: boolean
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
    const allKeys = [...memory.keys()]
      .filter((key) => !options.prefix || key.startsWith(options.prefix))
      .sort()
    const cursorIndex = options.cursor ? allKeys.indexOf(options.cursor) : -1
    const start = cursorIndex >= 0
      ? cursorIndex + 1
      : options.cursor
        ? allKeys.findIndex((key) => key > options.cursor!)
        : 0
    const normalizedStart = start >= 0 ? start : allKeys.length
    const limit = Math.max(1, options.limit ?? 1000)
    const keys = allKeys
      .slice(normalizedStart, normalizedStart + limit)
      .map((name) => ({ name }))
    const nextOffset = normalizedStart + keys.length
    const listComplete = nextOffset >= allKeys.length
    return {
      keys,
      cursor: listComplete ? undefined : keys[keys.length - 1]?.name,
      list_complete: listComplete,
    }
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

  async listKeyPage(prefix: string, cursor?: string, limit = 1000): Promise<KvKeyPage> {
    try {
      const result = await this.kv.list({
        prefix,
        cursor,
        limit: Math.min(1000, Math.max(1, limit)),
      })
      return {
        keys: result.keys.map(({ name }) => name),
        cursor: result.cursor,
        listComplete: result.list_complete,
      }
    } catch (error) {
      throw new Error(`KV read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
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
