import type { CloudflareBindings } from '../bindings'
import type { DocumentMeta, Paginated, RecipientCandidate, WikiNode, WikiSpace } from '../shared/types'
import { AppError } from '../shared/errors'
import { KvRepository } from '../repositories/kv'
import { decryptJson, encryptJson } from '../auth/crypto'

interface FeishuEnvelope<T> {
  code: number
  msg: string
  data: T
}

interface TenantTokenRecord {
  token: string
  expiresAt: number
}

interface RawWikiNode {
  space_id: string
  node_token: string
  obj_token: string
  obj_type: string
  title: string
  parent_node_token?: string
  has_child?: boolean
  obj_edit_time?: string
}

interface RawWikiSpace {
  space_id: string
  name: string
  description?: string
  space_type?: string
  visibility?: string
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class FeishuClient {
  private readonly repository: KvRepository

  constructor(private readonly env: CloudflareBindings) {
    this.repository = new KvRepository(env)
  }

  private async request<T>(path: string, token: string, init: RequestInit = {}, retries = 3): Promise<T> {
    const url = new URL(path, this.env.FEISHU_API_BASE_URL)
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          ...init.headers,
        },
      })
      let payload: FeishuEnvelope<T>
      try {
        payload = (await response.json()) as FeishuEnvelope<T>
      } catch {
        if (response.status >= 500 && attempt < retries) {
          await wait(300 * 2 ** attempt + Math.floor(Math.random() * 200))
          continue
        }
        throw new AppError('FEISHU_API_ERROR', `飞书接口返回了不可解析的响应（HTTP ${response.status}）`, 502)
      }
      if (response.ok && payload.code === 0) return payload.data

      const retryable = response.status === 429 || [502, 503, 504].includes(response.status) || payload.code === 99991400
      if (retryable && attempt < retries) {
        const retryAfter = Number(response.headers.get('Retry-After') || 0) * 1000
        await wait(retryAfter || 300 * 2 ** attempt + Math.floor(Math.random() * 200))
        continue
      }
      if (response.status === 401 || payload.code === 99991663) throw new AppError('AUTH_EXPIRED', payload.msg || '飞书凭证已失效', 401)
      if (response.status === 403 || [131006, 99991672].includes(payload.code)) {
        throw new AppError('FEISHU_PERMISSION_DENIED', payload.msg || '飞书资源权限不足', 403)
      }
      if (response.status === 429) throw new AppError('RATE_LIMITED', payload.msg || '飞书接口限流', 429)
      throw new AppError('FEISHU_API_ERROR', payload.msg || `飞书接口调用失败（${payload.code}）`, 502, payload)
    }
    throw new AppError('FEISHU_API_ERROR', '飞书接口调用失败', 502)
  }

  async getTenantAccessToken(): Promise<string> {
    const stored = await this.repository.get<{ encrypted?: string; token?: string; expiresAt?: number }>('token:tenant')
    let cached: TenantTokenRecord | null = null
    let migrateCached = false
    if (stored?.encrypted) {
      try {
        cached = await decryptJson<TenantTokenRecord>(this.env, stored.encrypted)
      } catch {
        cached = null
      }
    } else if (stored?.token && stored.expiresAt) {
      // Read the pre-encryption shape once so upgrades do not invalidate a live token.
      cached = { token: stored.token, expiresAt: stored.expiresAt }
      migrateCached = true
    }
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) {
      if (migrateCached) {
        await this.repository.put('token:tenant', {
          encrypted: await encryptJson(this.env, cached),
        }, Math.max(60, Math.floor((cached.expiresAt - Date.now()) / 1000)))
      }
      return cached.token
    }
    if (!this.env.FEISHU_APP_ID || !this.env.FEISHU_APP_SECRET) {
      throw new AppError('INVALID_REQUEST', '尚未配置 FEISHU_APP_ID/FEISHU_APP_SECRET', 503)
    }
    const response = await fetch(new URL('/open-apis/auth/v3/tenant_access_token/internal', this.env.FEISHU_API_BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.env.FEISHU_APP_ID, app_secret: this.env.FEISHU_APP_SECRET }),
    })
    let payload: { code: number; msg: string; tenant_access_token?: string; expire?: number }
    try {
      payload = (await response.json()) as typeof payload
    } catch {
      throw new AppError('FEISHU_API_ERROR', '获取 tenant token 时飞书返回了不可解析的响应', 502)
    }
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token || !payload.expire) {
      throw new AppError('FEISHU_API_ERROR', payload.msg || '获取 tenant token 失败', 502)
    }
    const record: TenantTokenRecord = {
      token: payload.tenant_access_token,
      expiresAt: Date.now() + payload.expire * 1000,
    }
    await this.repository.put('token:tenant', {
      encrypted: await encryptJson(this.env, record),
    }, Math.max(60, payload.expire - 60))
    return payload.tenant_access_token
  }

  async listSpaces(token: string, pageToken?: string): Promise<Paginated<WikiSpace>> {
    const params = new URLSearchParams({ page_size: '50' })
    if (pageToken) params.set('page_token', pageToken)
    const data = await this.request<{
      items?: Array<{ space_id: string; name: string; description?: string; space_type?: string; visibility?: string }>
      page_token?: string
      has_more?: boolean
    }>(`/open-apis/wiki/v2/spaces?${params}`, token)
    return {
      items: (data.items || []).map((space) => this.mapWikiSpace(space)),
      nextCursor: data.has_more ? data.page_token || null : null,
    }
  }

  async getWikiSpace(token: string, spaceId: string): Promise<WikiSpace> {
    const data = await this.request<{ space?: RawWikiSpace } | RawWikiSpace>(
      `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}`,
      token,
    )
    const space = 'space' in data && data.space ? data.space : data as RawWikiSpace
    if (!space?.space_id || !space.name) throw new AppError('FEISHU_API_ERROR', '飞书知识空间响应缺少必要字段', 502)
    return this.mapWikiSpace(space)
  }

  async getWikiNode(token: string, nodeToken: string): Promise<WikiNode> {
    const params = new URLSearchParams({ token: nodeToken, obj_type: 'wiki' })
    const data = await this.request<{ node: RawWikiNode }>(`/open-apis/wiki/v2/spaces/get_node?${params}`, token)
    return this.mapWikiNode(data.node, [])
  }

  async listWikiChildren(
    token: string,
    spaceId: string,
    parentNodeToken?: string,
    pageToken?: string,
  ): Promise<Paginated<WikiNode>> {
    const params = new URLSearchParams({ page_size: '50' })
    if (parentNodeToken) params.set('parent_node_token', parentNodeToken)
    if (pageToken) params.set('page_token', pageToken)
    const data = await this.request<{ items?: RawWikiNode[]; page_token?: string; has_more?: boolean }>(
      `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${params}`,
      token,
    )
    return {
      items: (data.items || []).map((node) => this.mapWikiNode(node, [])),
      nextCursor: data.has_more ? data.page_token || null : null,
    }
  }

  async batchQueryDocumentMeta(token: string, documentTokens: string[]): Promise<{ metas: DocumentMeta[]; failed: string[] }> {
    if (documentTokens.length > 200) throw new AppError('INVALID_REQUEST', '单次元数据查询不能超过 200 个文档', 400)
    if (documentTokens.length === 0) return { metas: [], failed: [] }
    const data = await this.request<{
      metas?: Array<{
        doc_token: string
        title: string
        owner_id?: string
        latest_modify_user?: string
        latest_modify_time: string
        url?: string
      }>
      failed_list?: Array<{ token: string; code: number }>
    }>('/open-apis/drive/v1/metas/batch_query?user_id_type=open_id', token, {
      method: 'POST',
      body: JSON.stringify({
        request_docs: documentTokens.map((doc_token) => ({ doc_token, doc_type: 'docx' })),
        with_url: true,
      }),
    })
    return {
      metas: (data.metas || []).map((meta) => ({
        documentToken: meta.doc_token,
        title: meta.title,
        url: meta.url || '',
        ownerId: meta.owner_id,
        latestModifyUser: meta.latest_modify_user,
        latestModifyTime: meta.latest_modify_time,
      })),
      failed: (data.failed_list || []).map((item) => item.token),
    }
  }

  async getUser(token: string, openId: string): Promise<{ id: string; name: string; avatarUrl?: string }> {
    const data = await this.request<{
      user: { open_id: string; name?: string; avatar?: { avatar_72?: string } }
    }>(`/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`, token)
    return { id: data.user.open_id, name: data.user.name || openId, avatarUrl: data.user.avatar?.avatar_72 }
  }

  async getChat(token: string, chatId: string): Promise<{ id: string; name: string; avatarUrl?: string; description?: string }> {
    const data = await this.request<{ chat?: { chat_id: string; name: string; avatar?: string; description?: string; chat_status?: string } } | { chat_id: string; name: string; avatar?: string; description?: string; chat_status?: string }>(
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      token,
    )
    const chat = 'chat' in data && data.chat ? data.chat : data as { chat_id: string; name: string; avatar?: string; description?: string; chat_status?: string }
    if (!chat?.chat_id || !chat.name || ['dissolved', 'dissolved_save'].includes(chat.chat_status || '')) {
      throw new AppError('FEISHU_PERMISSION_DENIED', '群聊不存在或应用无权访问', 403)
    }
    return { id: chat.chat_id, name: chat.name, avatarUrl: chat.avatar, description: chat.description }
  }

  async listChats(token: string, pageToken?: string): Promise<Paginated<RecipientCandidate>> {
    const params = new URLSearchParams({ page_size: '100', sort_type: 'ByCreateTimeAsc' })
    if (pageToken) params.set('page_token', pageToken)
    const data = await this.request<{
      items?: Array<{ chat_id: string; name: string; avatar?: string; description?: string; chat_status?: string }>
      page_token?: string
      has_more?: boolean
    }>(`/open-apis/im/v1/chats?${params}`, token)
    return {
      items: (data.items || [])
        .filter((chat) => chat.chat_status !== 'dissolved' && chat.chat_status !== 'dissolved_save')
        .map((chat) => ({ id: chat.chat_id, type: 'chat', name: chat.name, avatarUrl: chat.avatar, description: chat.description })),
      nextCursor: data.has_more ? data.page_token || null : null,
    }
  }

  async listUsers(token: string, pageToken?: string): Promise<Paginated<RecipientCandidate>> {
    const params = new URLSearchParams({
      department_id: '0',
      department_id_type: 'open_department_id',
      user_id_type: 'open_id',
      page_size: '50',
    })
    if (pageToken) params.set('page_token', pageToken)
    const data = await this.request<{
      items?: Array<{ open_id: string; name?: string; avatar?: { avatar_72?: string }; status?: { is_resigned?: boolean } }>
      page_token?: string
      has_more?: boolean
    }>(`/open-apis/contact/v3/users/find_by_department?${params}`, token)
    return {
      items: (data.items || [])
        .filter((user) => !user.status?.is_resigned)
        .map((user) => ({ id: user.open_id, type: 'user', name: user.name || user.open_id, avatarUrl: user.avatar?.avatar_72 })),
      nextCursor: data.has_more ? data.page_token || null : null,
    }
  }

  async sendMessage(
    token: string,
    recipient: { type: 'user' | 'chat'; openId?: string; chatId?: string },
    text: string,
    uuid: string,
  ): Promise<string> {
    const receiveId = recipient.type === 'user' ? recipient.openId : recipient.chatId
    if (!receiveId) throw new AppError('INVALID_REQUEST', '通知接收人缺少飞书 ID', 400)
    const receiveType = recipient.type === 'user' ? 'open_id' : 'chat_id'
    const data = await this.request<{ message_id: string }>(
      `/open-apis/im/v1/messages?receive_id_type=${receiveType}`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
          uuid: uuid.slice(0, 50),
        }),
      },
    )
    return data.message_id
  }

  private mapWikiNode(node: RawWikiNode, parentTitles: string[]): WikiNode {
    return {
      spaceId: node.space_id,
      nodeToken: node.node_token,
      objToken: node.obj_token,
      objType: node.obj_type,
      title: node.title,
      parentNodeToken: node.parent_node_token,
      parentTitles,
      hasChild: node.has_child,
      editTime: node.obj_edit_time,
    }
  }

  private mapWikiSpace(space: RawWikiSpace): WikiSpace {
    return {
      spaceId: space.space_id,
      name: space.name,
      description: space.description,
      spaceType: space.space_type,
      visibility: space.visibility,
    }
  }
}
