import { afterEach, describe, expect, it } from 'vitest'
import app from './app'
import { KvRepository } from './repositories/kv'
import type { CloudflareBindings, SessionRecord } from './bindings'
import { ConfigRepository } from './repositories/config'
import { encryptJson } from './auth/crypto'
import type { FeishuUserToken } from './shared/types'

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
} as CloudflareBindings

afterEach(() => KvRepository.clearMemory())

async function sessionCookie(id: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('local-development-only'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return `${id}.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`
}

describe('Hono API boundaries', () => {
  it('exposes health without a session', async () => {
    const response = await app.request('http://localhost/api/health', {}, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { status: 'ok' } })
  })

  it('does not expose management routes without authentication', async () => {
    const response = await app.request('http://localhost/api/wiki/monitors', {}, env)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'AUTH_REQUIRED' },
    })
  })

  it('allows unauthorised users to log out their own session endpoint', async () => {
    const response = await app.request('http://localhost/api/auth/logout', { method: 'POST' }, env)
    expect(response.status).toBe(401)
  })

  it('preserves a configured root node when only the enabled flag is updated', async () => {
    const session: SessionRecord = {
      id: 'ses_test',
      userId: 'user_1',
      openId: 'ou_admin',
      name: 'Admin',
      isAdmin: true,
      csrfToken: 'csrf_test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const kv = new KvRepository(env)
    await kv.put('auth:session:ses_test', session, 60)
    const token: FeishuUserToken = {
      schemaVersion: 1,
      userId: 'user_1',
      openId: 'ou_admin',
      accessToken: 'user-token',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      scope: 'wiki:wiki:readonly',
    }
    await kv.put('token:user:user_1', { encrypted: await encryptJson(env, token) })
    await new ConfigRepository(env).putMonitor({
      schemaVersion: 1,
      id: 'mon_1',
      enabled: true,
      spaceId: 'spc_1',
      spaceName: 'Wiki',
      rootNodeToken: 'wik_root',
      rootNodeTitle: 'Root',
      pollIntervalMinutes: 15,
      notifyOnFirstScan: false,
      authUserId: 'user_1',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const response = await app.request('http://localhost/api/wiki/monitors/mon_1', {
      method: 'PUT',
      headers: {
        Cookie: `fwm_session=${await sessionCookie('ses_test')}`,
        Origin: env.APP_ORIGIN,
        'X-CSRF-Token': 'csrf_test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    }, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { enabled: false, rootNodeToken: 'wik_root' } })
  })

  it('rejects an invalid monitor polling interval before writing configuration', async () => {
    const session: SessionRecord = {
      id: 'ses_interval',
      userId: 'user_interval',
      openId: 'ou_admin',
      name: 'Admin',
      isAdmin: true,
      csrfToken: 'csrf_interval',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const kv = new KvRepository(env)
    await kv.put('auth:session:ses_interval', session, 60)
    const response = await app.request('http://localhost/api/wiki/monitors', {
      method: 'POST',
      headers: {
        Cookie: `fwm_session=${await sessionCookie('ses_interval')}`,
        Origin: env.APP_ORIGIN,
        'X-CSRF-Token': 'csrf_interval',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: 'spc_1', pollIntervalMinutes: 0 }),
    }, env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: 'INVALID_REQUEST' } })
  })
})
