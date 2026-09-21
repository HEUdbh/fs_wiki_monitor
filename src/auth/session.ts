import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv, SessionRecord } from '../bindings'
import { AppError } from '../shared/errors'
import { KvRepository } from '../repositories/kv'
import { randomId } from './crypto'

const COOKIE_NAME = 'fwm_session'

function signingSecret(env: AppEnv['Bindings']): string {
  if (env.SESSION_SIGNING_KEY) return env.SESSION_SIGNING_KEY
  if (env.APP_ORIGIN.startsWith('http://localhost') || env.APP_ORIGIN.startsWith('http://127.0.0.1')) return 'local-development-only'
  throw new AppError('INVALID_REQUEST', '生产环境缺少 SESSION_SIGNING_KEY', 503)
}

async function signature(secret: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionId)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function createSession(c: Context<AppEnv>, user: Omit<SessionRecord, 'id' | 'expiresAt' | 'csrfToken'>) {
  const ttl = Number(c.env.SESSION_TTL_SECONDS || 604800)
  const id = randomId('ses')
  const record: SessionRecord = {
    ...user,
    id,
    csrfToken: randomId('csrf'),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  }
  await new KvRepository(c.env).put(`auth:session:${id}`, record, ttl)
  const sig = await signature(signingSecret(c.env), id)
  setCookie(c, COOKIE_NAME, `${id}.${sig}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: ttl,
  })
  return record
}

export async function readSession(c: Context<AppEnv>): Promise<SessionRecord | null> {
  const cookie = getCookie(c, COOKIE_NAME)
  if (!cookie) return null
  const separator = cookie.lastIndexOf('.')
  if (separator < 1) return null
  const id = cookie.slice(0, separator)
  const received = cookie.slice(separator + 1)
  let expected: string
  try {
    expected = await signature(signingSecret(c.env), id)
  } catch {
    return null
  }
  if (received !== expected) return null
  const record = await new KvRepository(c.env).get<SessionRecord>(`auth:session:${id}`)
  if (!record || new Date(record.expiresAt).getTime() <= Date.now()) return null
  return record
}

export async function destroySession(c: Context<AppEnv>) {
  const session = await readSession(c)
  if (session) await new KvRepository(c.env).delete(`auth:session:${session.id}`)
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await readSession(c)
  if (!session) throw new AppError('AUTH_REQUIRED', '请先使用飞书登录', 401)
  c.set('session', session)
  await next()
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session') || await readSession(c)
  if (!session) throw new AppError('AUTH_REQUIRED', '请先使用飞书登录', 401)
  if (!session.isAdmin) throw new AppError('FORBIDDEN', '当前账号不是系统管理员', 403)
  c.set('session', session)
  await next()
}

export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next()
  const session = c.get('session')
  const origin = c.req.header('Origin')
  if (origin && origin !== c.env.APP_ORIGIN) throw new AppError('FORBIDDEN', '请求来源不受信任', 403)
  if (!session || c.req.header('X-CSRF-Token') !== session.csrfToken) {
    throw new AppError('FORBIDDEN', 'CSRF 校验失败，请刷新页面后重试', 403)
  }
  await next()
}
