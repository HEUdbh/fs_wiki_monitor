import { describe, expect, it } from 'vitest'
import { decryptJson, encryptJson, sha256 } from './crypto'
import type { CloudflareBindings } from '../bindings'

const env = {
  TOKEN_ENCRYPTION_KEY: 'test-encryption-key',
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
} as CloudflareBindings

describe('crypto helpers', () => {
  it('round-trips encrypted JSON without exposing plaintext', async () => {
    const encrypted = await encryptJson(env, { token: 'secret-token' })
    expect(encrypted).not.toContain('secret-token')
    await expect(decryptJson(env, encrypted)).resolves.toEqual({ token: 'secret-token' })
  })

  it('allows the documented local-development fallback when no encryption secret is set', async () => {
    const localEnv = {
      ...env,
      APP_ORIGIN: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: undefined,
      SESSION_SIGNING_KEY: undefined,
    } as CloudflareBindings

    const encrypted = await encryptJson(localEnv, { token: 'local-token' })
    await expect(decryptJson(localEnv, encrypted)).resolves.toEqual({ token: 'local-token' })
  })

  it('rejects production encryption without TOKEN_ENCRYPTION_KEY', async () => {
    const productionEnv = {
      ...env,
      APP_ORIGIN: 'https://monitor.example.com',
      TOKEN_ENCRYPTION_KEY: undefined,
      SESSION_SIGNING_KEY: undefined,
    } as CloudflareBindings

    await expect(encryptJson(productionEnv, { token: 'must-not-be-stored' })).rejects.toThrow()
  })

  it('creates stable sha256 output', async () => {
    await expect(sha256('same')).resolves.toBe(await sha256('same'))
  })
})
