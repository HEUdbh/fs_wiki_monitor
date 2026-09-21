export interface StoredRecord {
  schemaVersion: 1
}

export interface FeishuUserToken extends StoredRecord {
  userId: string
  openId: string
  accessToken: string
  refreshToken?: string
  expiresAt: string
  refreshExpiresAt?: string
  scope: string
}

export interface WikiSpace {
  spaceId: string
  name: string
  description?: string
  spaceType?: string
  visibility?: string
}

export interface WikiNode {
  spaceId: string
  nodeToken: string
  objToken: string
  objType: string
  title: string
  parentNodeToken?: string
  parentTitles: string[]
  hasChild?: boolean
  editTime?: string
}

export interface WikiMonitorConfig extends StoredRecord {
  id: string
  enabled: boolean
  spaceId: string
  spaceName: string
  rootNodeToken?: string
  rootNodeTitle?: string
  pollIntervalMinutes: number
  notifyOnFirstScan: boolean
  authUserId: string
  status: 'active' | 'auth_required' | 'error'
  createdAt: string
  updatedAt: string
}

export interface Recipient extends StoredRecord {
  id: string
  type: 'user' | 'chat'
  openId?: string
  chatId?: string
  name: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface RecipientCandidate {
  id: string
  type: 'user' | 'chat'
  name: string
  avatarUrl?: string
  description?: string
}

export interface NotificationTemplate extends StoredRecord {
  id: string
  name: string
  enabled: boolean
  content: string
  createdAt: string
  updatedAt: string
}

export interface DocumentSnapshot extends StoredRecord {
  monitorId: string
  documentToken: string
  wikiNodeToken: string
  spaceId: string
  title: string
  url: string
  lastEditTime: string
  lastEditorId?: string
  lastEditorName?: string
  lastCheckedAt: string
  status: 'active' | 'error' | 'removed'
}

export interface DocumentChangeEvent extends StoredRecord {
  eventId: string
  monitorId: string
  spaceId: string
  wikiName: string
  documentToken: string
  wikiNodeToken: string
  documentTitle: string
  documentUrl: string
  previousEditTime: string
  updatedAt: string
  editorId?: string
  editorName?: string
  detectedAt: string
}

export interface RunError {
  code: string
  message: string
  documentToken?: string
}

export interface RunSummary extends StoredRecord {
  runId: string
  trigger: 'cron' | 'manual'
  startedAt: string
  finishedAt?: string
  status: 'running' | 'success' | 'partial' | 'failed' | 'skipped'
  scanned: number
  changed: number
  notified: number
  failed: number
  errors: RunError[]
}

export interface DocumentMeta {
  documentToken: string
  title: string
  url: string
  ownerId?: string
  latestModifyUser?: string
  latestModifyTime: string
}

export interface Paginated<T> {
  items: T[]
  nextCursor: string | null
}
