import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudflareBindings } from '../bindings'
import { FeishuClient } from './client'
import { KvRepository } from '../repositories/kv'

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  FEISHU_API_BASE_URL: 'https://open.feishu.cn',
  FEISHU_ACCOUNTS_BASE_URL: 'https://accounts.feishu.cn',
  SESSION_TTL_SECONDS: '3600',
  MONITOR_LOCK_TTL_SECONDS: '600',
  ADMIN_OPEN_IDS: '',
} as CloudflareBindings

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('FeishuClient official API contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    KvRepository.clearMemory()
  })

  it('maps Wiki child pagination and node fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      items: [{
        space_id: 'spc_1',
        node_token: 'wik_1',
        obj_token: 'dox_1',
        obj_type: 'docx',
        title: '设计文档',
        parent_node_token: 'wik_root',
        has_child: false,
        obj_edit_time: '1789952400',
      }],
      has_more: true,
      page_token: 'cursor_2',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new FeishuClient(env).listWikiChildren('u-token', 'spc_1', 'wik_root', 'cursor_1')
    expect(result.nextCursor).toBe('cursor_2')
    expect(result.items[0]).toMatchObject({
      spaceId: 'spc_1',
      nodeToken: 'wik_1',
      objToken: 'dox_1',
      objType: 'docx',
      editTime: '1789952400',
    })
    const request = fetchMock.mock.calls[0][0] as URL
    expect(request.toString()).toContain('/open-apis/wiki/v2/spaces/spc_1/nodes?')
    expect(request.searchParams.get('parent_node_token')).toBe('wik_root')
    expect(request.searchParams.get('page_token')).toBe('cursor_1')
  })

  it('maps an empty Wiki page while preserving a continuation cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      items: [],
      has_more: true,
      page_token: 'cursor_after_empty',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new FeishuClient(env).listWikiChildren('u-token', 'spc_1', undefined, 'cursor_empty'))
      .resolves.toMatchObject({ items: [], nextCursor: 'cursor_after_empty' })
  })

  it('sends the documented Drive batch metadata request and maps editor fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      metas: [{
        doc_token: 'dox_1',
        title: '设计文档',
        owner_id: 'ou_owner',
        latest_modify_user: 'ou_editor',
        latest_modify_time: '1789952400',
        url: 'https://example.feishu.cn/docx/dox_1',
      }],
      failed_list: [{ token: 'dox_failed', code: 1061002 }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new FeishuClient(env).batchQueryDocumentMeta('u-token', ['dox_1', 'dox_failed'])
    expect(result).toEqual({
      metas: [{
        documentToken: 'dox_1',
        title: '设计文档',
        url: 'https://example.feishu.cn/docx/dox_1',
        ownerId: 'ou_owner',
        latestModifyUser: 'ou_editor',
        latestModifyTime: '1789952400',
      }],
      failed: ['dox_failed'],
    })
    const [request, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(request.searchParams.get('user_id_type')).toBe('open_id')
    expect(JSON.parse(String(init.body))).toEqual({
      request_docs: [
        { doc_token: 'dox_1', doc_type: 'docx' },
        { doc_token: 'dox_failed', doc_type: 'docx' },
      ],
      with_url: true,
    })
  })

  it('serializes text content and receive_id_type for user messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message_id: 'om_1' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new FeishuClient(env).sendMessage('tenant-token', { type: 'user', openId: 'ou_1' }, '文档已更新', 'uuid-1'))
      .resolves.toBe('om_1')
    const [request, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(request.searchParams.get('receive_id_type')).toBe('open_id')
    expect(JSON.parse(String(init.body))).toEqual({
      receive_id: 'ou_1',
      msg_type: 'text',
      content: JSON.stringify({ text: '文档已更新' }),
      uuid: 'uuid-1',
    })
  })

  it('uses the official chat list pagination fields and excludes dissolved chats', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      items: [
        { chat_id: 'oc_active', name: '研发群', description: '通知群', chat_status: 'normal', chat_mode: 'group' },
        { chat_id: 'oc_old', name: '已解散群', chat_status: 'dissolved_save', chat_mode: 'group' },
      ],
      has_more: true,
      page_token: 'chat_cursor_2',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new FeishuClient(env).listChats('user-token', 'chat_cursor_1')
    expect(result).toMatchObject({
      items: [{ id: 'oc_active', type: 'chat', name: '研发群', description: '通知群' }],
      nextCursor: 'chat_cursor_2',
    })
    expect(result.items).toHaveLength(1)
    const request = fetchMock.mock.calls[0][0] as URL
    expect(request.pathname).toBe('/open-apis/im/v1/chats')
    expect(request.searchParams.get('page_size')).toBe('100')
    expect(request.searchParams.get('page_token')).toBe('chat_cursor_1')
    expect(request.searchParams.get('sort_type')).toBe('ByCreateTimeAsc')
  })

  it('rejects a dissolved chat when validating a recipient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      chat_id: 'oc_old',
      name: '已解散群',
      chat_status: 'dissolved_save',
    })))

    await expect(new FeishuClient(env).getChat('tenant-token', 'oc_old')).rejects.toMatchObject({
      code: 'FEISHU_PERMISSION_DENIED',
    })
  })

  it('encrypts cached tenant tokens instead of storing the bearer value directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      tenant_access_token: 'tenant-secret',
      expire: 7200,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const configuredEnv = { ...env, FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' } as CloudflareBindings
    await expect(new FeishuClient(configuredEnv).getTenantAccessToken()).resolves.toBe('tenant-secret')
    const stored = await new KvRepository(configuredEnv).get<{ encrypted?: string; token?: string }>('token:tenant')
    expect(stored?.encrypted).toBeTruthy()
    expect(stored?.token).toBeUndefined()
    expect(stored?.encrypted).not.toContain('tenant-secret')
  })
})
