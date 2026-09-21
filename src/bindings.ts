export interface CloudflareBindings {
  FEISHU_MONITOR_KV?: KVNamespace
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
  FEISHU_REDIRECT_URI?: string
  TOKEN_ENCRYPTION_KEY?: string
  SESSION_SIGNING_KEY?: string
  APP_ORIGIN: string
  FEISHU_API_BASE_URL: string
  FEISHU_ACCOUNTS_BASE_URL: string
  SESSION_TTL_SECONDS: string
  MONITOR_LOCK_TTL_SECONDS: string
  ADMIN_OPEN_IDS: string
}

export interface AppVariables {
  requestId: string
  session?: SessionRecord
}

export interface SessionRecord {
  id: string
  userId: string
  openId: string
  name: string
  avatarUrl?: string
  isAdmin: boolean
  csrfToken: string
  expiresAt: string
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: AppVariables
}
