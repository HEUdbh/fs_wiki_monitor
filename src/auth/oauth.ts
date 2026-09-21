import type { Context } from 'hono'
import type { AppEnv } from '../bindings'
import type { FeishuUserToken } from '../shared/types'
import { AppError } from '../shared/errors'
import { KvRepository } from '../repositories/kv'
import { decryptJson, encryptJson, randomId, sha256 } from './crypto'

interface OAuthState {
  state: string
  verifier: string
  returnTo: string
  createdAt: string
}

interface TokenResponse {
  code: number
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_token_expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface UserInfoResponse {
  code: number
  msg: string
  data?: {
    name: string
    open_id: string
    user_id?: string
    avatar_url?: string
  }
}

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function createAuthorizationUrl(c: Context<AppEnv>, returnTo?: string): Promise<string> {
  if (!c.env.FEISHU_APP_ID || !c.env.FEISHU_REDIRECT_URI) {
    throw new AppError('INVALID_REQUEST', '尚未配置飞书 OAuth 环境变量', 503)
  }
  const state = randomId('state')
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '')
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const record: OAuthState = { state, verifier, returnTo: safeReturnTo(returnTo), createdAt: new Date().toISOString() }
  await new KvRepository(c.env).put(`auth:state:${state}`, record, 600)

  const url = new URL('/open-apis/authen/v1/authorize', c.env.FEISHU_ACCOUNTS_BASE_URL)
  url.searchParams.set('client_id', c.env.FEISHU_APP_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', c.env.FEISHU_REDIRECT_URI)
  url.searchParams.set('scope', 'offline_access wiki:wiki:readonly drive:drive.metadata:readonly contact:contact.base:readonly im:chat:readonly')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', base64Url(challengeBytes))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export async function exchangeAuthorizationCode(c: Context<AppEnv>, code: string, state: string) {
  const repository = new KvRepository(c.env)
  const oauthState = await consumeOAuthState(c, state)
  if (!oauthState) throw new AppError('INVALID_REQUEST', 'OAuth state 无效或已过期', 400)
  if (!c.env.FEISHU_APP_ID || !c.env.FEISHU_APP_SECRET || !c.env.FEISHU_REDIRECT_URI) {
    throw new AppError('INVALID_REQUEST', '飞书 OAuth 配置不完整', 503)
  }
  const tokenResponse = await fetch(new URL('/oauth/v3/token', c.env.FEISHU_ACCOUNTS_BASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: c.env.FEISHU_APP_ID,
      client_secret: c.env.FEISHU_APP_SECRET,
      code,
      redirect_uri: c.env.FEISHU_REDIRECT_URI,
      code_verifier: oauthState.verifier,
    }),
  })
  const token = (await tokenResponse.json()) as TokenResponse
  if (!tokenResponse.ok || token.code !== 0 || !token.access_token) {
    throw new AppError('AUTH_EXPIRED', token.error_description || token.error || '无法获取飞书用户凭证', 401)
  }

  const userResponse = await fetch(new URL('/open-apis/authen/v1/user_info', c.env.FEISHU_API_BASE_URL), {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
  const userInfo = (await userResponse.json()) as UserInfoResponse
  if (!userResponse.ok || userInfo.code !== 0 || !userInfo.data) {
    throw new AppError('AUTH_EXPIRED', userInfo.msg || '无法获取飞书用户信息', 401)
  }

  const now = Date.now()
  const userId = userInfo.data.user_id || userInfo.data.open_id
  const storedToken: FeishuUserToken = {
    schemaVersion: 1,
    userId,
    openId: userInfo.data.open_id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
    refreshExpiresAt: token.refresh_token_expires_in
      ? new Date(now + token.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    scope: token.scope || '',
  }
  await repository.put(`token:user:${userId}`, { encrypted: await encryptJson(c.env, storedToken) })
  const admins = (c.env.ADMIN_OPEN_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
  const isAdmin = admins.includes(userInfo.data.open_id)
  return {
    user: {
      userId,
      openId: userInfo.data.open_id,
      name: userInfo.data.name,
      avatarUrl: userInfo.data.avatar_url,
      isAdmin,
    },
    returnTo: oauthState.returnTo,
  }
}

export async function consumeOAuthState(c: Context<AppEnv>, state: string): Promise<OAuthState | null> {
  if (!state || state.length > 200) return null
  const repository = new KvRepository(c.env)
  const stateKey = `auth:state:${state}`
  const oauthState = await repository.get<OAuthState>(stateKey)
  await repository.delete(stateKey)
  if (!oauthState || oauthState.state !== state) return null
  return oauthState
}

export async function getStoredUserToken(env: AppEnv['Bindings'], userId: string): Promise<FeishuUserToken> {
  const repository = new KvRepository(env)
  const record = await repository.get<{ encrypted: string }>(`token:user:${userId}`)
  if (!record) throw new AppError('AUTH_REQUIRED', '未找到飞书用户授权', 401)
  const token = await decryptJson<FeishuUserToken>(env, record.encrypted)
  if (new Date(token.expiresAt).getTime() > Date.now() + 5 * 60_000) return token
  if (!token.refreshToken || !env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new AppError('AUTH_EXPIRED', '飞书用户授权已过期，请重新登录', 401)
  }
  if (token.refreshExpiresAt && new Date(token.refreshExpiresAt).getTime() <= Date.now()) {
    throw new AppError('AUTH_EXPIRED', '飞书 Refresh Token 已过期，请重新登录', 401)
  }
  const response = await fetch(new URL('/oauth/v3/token', env.FEISHU_ACCOUNTS_BASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.FEISHU_APP_ID,
      client_secret: env.FEISHU_APP_SECRET,
      refresh_token: token.refreshToken,
    }),
  })
  const refreshed = (await response.json()) as TokenResponse
  if (!response.ok || refreshed.code !== 0 || !refreshed.access_token) {
    throw new AppError('AUTH_EXPIRED', refreshed.error_description || '飞书用户授权刷新失败，请重新登录', 401)
  }
  const now = Date.now()
  const next: FeishuUserToken = {
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || token.refreshToken,
    expiresAt: new Date(now + refreshed.expires_in * 1000).toISOString(),
    refreshExpiresAt: refreshed.refresh_token_expires_in
      ? new Date(now + refreshed.refresh_token_expires_in * 1000).toISOString()
      : token.refreshExpiresAt,
    scope: refreshed.scope || token.scope,
  }
  await repository.put(`token:user:${userId}`, { encrypted: await encryptJson(env, next) })
  return next
}

export async function stableId(value: string): Promise<string> {
  return (await sha256(value)).slice(0, 40)
}
