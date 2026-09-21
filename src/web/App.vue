<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Activity,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Users,
  X,
} from 'lucide-vue-next'
import { api, del, post, put, setCsrfToken } from './api'

type Tab = 'overview' | 'wiki' | 'recipients' | 'template' | 'changes' | 'runs'

interface CurrentUser {
  userId: string
  openId: string
  name: string
  avatarUrl?: string
  isAdmin: boolean
  csrfToken: string
}

interface Monitor {
  id: string
  enabled: boolean
  spaceId: string
  spaceName: string
  rootNodeTitle?: string
  pollIntervalMinutes: number
  notifyOnFirstScan: boolean
  status: string
  updatedAt: string
}

interface Recipient {
  id: string
  type: 'user' | 'chat'
  openId?: string
  chatId?: string
  name: string
  enabled: boolean
}

interface Template {
  id: string
  name: string
  enabled: boolean
  content: string
  updatedAt: string
}

interface Run {
  runId: string
  trigger: 'cron' | 'manual'
  startedAt: string
  finishedAt?: string
  status: string
  scanned: number
  changed: number
  notified: number
  failed: number
  errors: Array<{ code: string; message: string }>
}

interface Change {
  eventId: string
  documentTitle: string
  documentUrl: string
  wikiName: string
  updatedAt: string
  editorName?: string
  editorId?: string
  detectedAt: string
}

interface Space { spaceId: string; name: string; description?: string; visibility?: string }
interface Candidate { id: string; type: 'user' | 'chat'; name: string; avatarUrl?: string; description?: string }
interface WikiNode { spaceId: string; nodeToken: string; objToken: string; objType: string; title: string; hasChild?: boolean; parentNodeToken?: string }

const activeTab = ref<Tab>('overview')
const authLoading = ref(true)
const loading = ref(false)
const running = ref(false)
const user = ref<CurrentUser | null>(null)
const monitors = ref<Monitor[]>([])
const recipients = ref<Recipient[]>([])
const templates = ref<Template[]>([])
const defaultTemplateId = ref('default')
const runs = ref<Run[]>([])
const changes = ref<Change[]>([])
const latestRun = ref<Run | null>(null)
const spaces = ref<Space[]>([])
const nodeDialog = ref(false)
const nodeSpace = ref<Space | null>(null)
const nodeItems = ref<WikiNode[]>([])
const nodeCursor = ref<string | null>(null)
const nodeParents = ref<Array<{ token: string; title: string }>>([])
const nodeLoading = ref(false)
const candidates = ref<Candidate[]>([])
const spaceDialog = ref(false)
const recipientDialog = ref(false)
const candidateType = ref<'user' | 'chat'>('user')
const searchQuery = ref('')
const candidateCursor = ref<string | null>(null)
const toast = ref<{ type: 'success' | 'error'; message: string } | null>(null)
const preview = ref('')

const navItems = [
  { id: 'overview' as const, label: '总览', icon: LayoutDashboard },
  { id: 'wiki' as const, label: '知识库', icon: BookOpen },
  { id: 'recipients' as const, label: '接收人', icon: Users },
  { id: 'template' as const, label: '消息模板', icon: MessageSquareText },
  { id: 'changes' as const, label: '更新记录', icon: FileText },
  { id: 'runs' as const, label: '运行记录', icon: Activity },
]

const currentTemplate = computed(() => templates.value.find((item) => item.id === defaultTemplateId.value) || templates.value[0])
const activeRecipients = computed(() => recipients.value.filter((item) => item.enabled).length)
const activeMonitors = computed(() => monitors.value.filter((item) => item.enabled).length)

function notify(type: 'success' | 'error', message: string) {
  toast.value = { type, message }
  window.setTimeout(() => { toast.value = null }, 4000)
}

function formatTime(value?: string) {
  if (!value) return '尚未运行'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function statusLabel(status: string) {
  return ({ success: '成功', partial: '部分失败', failed: '失败', running: '运行中', skipped: '已跳过', active: '正常' } as Record<string, string>)[status] || status
}

function variableToken(name: string) {
  return `{{${name}}}`
}

async function loadAuth() {
  try {
    const result = await api<{ authenticated: boolean; user: CurrentUser | null }>('/api/auth/me')
    user.value = result.user
    if (result.user?.csrfToken) setCsrfToken(result.user.csrfToken)
    if (result.authenticated && result.user?.isAdmin) await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '无法读取登录状态')
  } finally {
    authLoading.value = false
  }
}

async function loadDashboard() {
  loading.value = true
  try {
    const [monitorData, recipientData, templateData, runData, changeData, statusData] = await Promise.all([
      api<Monitor[]>('/api/wiki/monitors'),
      api<Recipient[]>('/api/recipients'),
      api<{ items: Template[]; defaultId: string }>('/api/templates'),
      api<{ items: Run[] }>('/api/runs'),
      api<{ items: Change[] }>('/api/changes'),
      api<Run | null>('/api/monitor/status'),
    ])
    monitors.value = monitorData
    recipients.value = recipientData
    templates.value = templateData.items
    defaultTemplateId.value = templateData.defaultId
    runs.value = runData.items
    changes.value = changeData.items
    latestRun.value = statusData
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '控制台数据加载失败')
  } finally {
    loading.value = false
  }
}

async function logout() {
  try {
    await post('/api/auth/logout')
    user.value = null
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '退出登录失败')
  }
}

async function openSpacePicker() {
  spaceDialog.value = true
  try {
    const data = await api<{ items: Space[] }>('/api/wiki/spaces')
    spaces.value = data.items
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '知识库加载失败')
  }
}

async function addSpace(space: Space) {
  nodeSpace.value = space
  nodeParents.value = []
  nodeItems.value = []
  nodeCursor.value = null
  spaceDialog.value = false
  nodeDialog.value = true
  await loadSpaceNodes()
}

async function loadSpaceNodes(append = false) {
  if (!nodeSpace.value) return
  nodeLoading.value = true
  try {
    const query = new URLSearchParams()
    const parent = nodeParents.value.at(-1)?.token
    if (parent) query.set('parentNodeToken', parent)
    if (append && nodeCursor.value) query.set('cursor', nodeCursor.value)
    const data = await api<{ items: WikiNode[]; nextCursor: string | null }>(`/api/wiki/spaces/${encodeURIComponent(nodeSpace.value.spaceId)}/tree?${query}`)
    nodeItems.value = append ? [...nodeItems.value, ...data.items] : data.items
    nodeCursor.value = data.nextCursor
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '知识库节点加载失败')
  } finally {
    nodeLoading.value = false
  }
}

async function chooseMonitor(root?: WikiNode) {
  if (!nodeSpace.value) return
  const currentParent = nodeParents.value.at(-1)
  const selectedRoot = root || (currentParent ? {
    nodeToken: currentParent.token,
    title: currentParent.title,
  } as WikiNode : undefined)
  try {
    await post('/api/wiki/monitors', {
      spaceId: nodeSpace.value.spaceId,
      rootNodeToken: selectedRoot?.nodeToken,
      rootNodeTitle: selectedRoot?.title,
      enabled: true,
      notifyOnFirstScan: false,
    })
    nodeDialog.value = false
    notify('success', `已开始监听“${nodeSpace.value.name}”${selectedRoot ? `的「${selectedRoot.title}」` : ''}`)
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '添加知识库失败')
  }
}

async function enterNode(node: WikiNode) {
  nodeParents.value.push({ token: node.nodeToken, title: node.title })
  nodeCursor.value = null
  await loadSpaceNodes()
}

async function leaveNode() {
  if (!nodeParents.value.length) return
  nodeParents.value.pop()
  nodeCursor.value = null
  await loadSpaceNodes()
}

async function toggleMonitor(monitor: Monitor) {
  try {
    await put(`/api/wiki/monitors/${monitor.id}`, { enabled: !monitor.enabled })
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '更新监听状态失败')
  }
}

async function removeMonitor(monitor: Monitor) {
  try {
    await del(`/api/wiki/monitors/${monitor.id}`)
    notify('success', `已移除“${monitor.spaceName}”`)
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '删除知识库失败')
  }
}

async function loadCandidates(type = candidateType.value, append = false) {
  candidateType.value = type
  const query = new URLSearchParams({ type, query: searchQuery.value })
  if (append && candidateCursor.value) query.set('cursor', candidateCursor.value)
  try {
    const data = await api<{ items: Candidate[]; nextCursor: string | null }>(`/api/recipient-candidates?${query}`)
    candidates.value = append ? [...candidates.value, ...data.items] : data.items
    candidateCursor.value = data.nextCursor
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '接收对象加载失败')
  }
}

async function openRecipientPicker() {
  recipientDialog.value = true
  searchQuery.value = ''
  candidateCursor.value = null
  await loadCandidates()
}

async function addRecipient(candidate: Candidate) {
  try {
    await post('/api/recipients', {
      type: candidate.type,
      openId: candidate.type === 'user' ? candidate.id : undefined,
      chatId: candidate.type === 'chat' ? candidate.id : undefined,
      enabled: true,
    })
    recipientDialog.value = false
    notify('success', `已添加“${candidate.name}”`)
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '添加接收人失败')
  }
}

async function toggleRecipient(recipient: Recipient) {
  try {
    await put(`/api/recipients/${recipient.id}`, { enabled: !recipient.enabled })
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '更新接收人状态失败')
  }
}

async function removeRecipient(recipient: Recipient) {
  try {
    await del(`/api/recipients/${recipient.id}`)
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '删除接收人失败')
  }
}

async function saveTemplate() {
  if (!currentTemplate.value) return
  try {
    await put(`/api/templates/${currentTemplate.value.id}`, currentTemplate.value)
    notify('success', '消息模板已保存')
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '模板保存失败')
  }
}

async function previewTemplate() {
  if (!currentTemplate.value) return
  try {
    const data = await post<{ content: string }>(`/api/templates/${currentTemplate.value.id}/preview`)
    preview.value = data.content
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '模板预览失败')
  }
}

async function runNow() {
  running.value = true
  try {
    const result = await post<{ accepted: boolean; runId: string }>('/api/monitor/run')
    notify('success', '扫描任务已提交')
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 800))
      const status = await api<Run | null>('/api/monitor/status')
      if (status?.runId === result.runId && status.status !== 'running') break
    }
    await loadDashboard()
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '扫描启动失败')
  } finally {
    running.value = false
  }
}

onMounted(loadAuth)
</script>

<template>
  <div v-if="authLoading" class="center-state">
    <LoaderCircle class="spin" :size="26" aria-hidden="true" />
    <span>正在读取登录状态</span>
  </div>

  <main v-else-if="!user" class="login-shell">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="brand-mark"><BookOpen :size="25" aria-hidden="true" /></div>
      <p class="eyebrow">FEISHU WIKI MONITOR</p>
      <h1 id="login-title">知识库更新，一目了然</h1>
      <p class="login-copy">登录后选择需要监听的知识库和通知对象。系统只记录更新时间与最后编辑人，不读取文档正文。</p>
      <a class="button primary login-button" href="/api/auth/login?returnTo=/">
        <LogIn :size="18" aria-hidden="true" />
        使用飞书登录
      </a>
      <p class="security-note">授权凭证仅保存在 Cloudflare Worker 端</p>
    </section>
  </main>

  <main v-else-if="!user.isAdmin" class="login-shell">
    <section class="login-panel" aria-labelledby="denied-title">
      <div class="brand-mark warning"><Settings2 :size="25" aria-hidden="true" /></div>
      <p class="eyebrow">需要管理员授权</p>
      <h1 id="denied-title">账号尚未加入管理员列表</h1>
      <p class="login-copy">将下方 Open ID 添加到 Worker 的 <code>ADMIN_OPEN_IDS</code>，重新部署后再次登录。</p>
      <code class="identity-code">{{ user.openId }}</code>
      <button class="button secondary" type="button" @click="logout"><LogOut :size="18" />退出登录</button>
    </section>
  </main>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark small"><BookOpen :size="20" aria-hidden="true" /></div>
        <div><strong>Wiki Monitor</strong><span>飞书知识库监控</span></div>
      </div>
      <nav aria-label="主导航">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          :class="['nav-item', { active: activeTab === item.id }]"
          :aria-current="activeTab === item.id ? 'page' : undefined"
          @click="activeTab = item.id"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="sidebar-user">
        <img v-if="user.avatarUrl" :src="user.avatarUrl" alt="" />
        <div v-else class="avatar-fallback">{{ user.name.slice(0, 1) }}</div>
        <div class="user-text"><strong>{{ user.name }}</strong><span>管理员</span></div>
        <button class="icon-button" type="button" title="退出登录" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ navItems.find((item) => item.id === activeTab)?.label }}</p>
          <h1>{{ activeTab === 'overview' ? '监控运行概览' : navItems.find((item) => item.id === activeTab)?.label }}</h1>
        </div>
        <div class="topbar-actions">
          <button class="icon-button" type="button" title="刷新" aria-label="刷新控制台数据" :disabled="loading" @click="loadDashboard">
            <RefreshCw :class="{ spin: loading }" :size="18" />
          </button>
          <button class="button primary" type="button" :disabled="running" @click="runNow">
            <LoaderCircle v-if="running" class="spin" :size="17" />
            <Play v-else :size="17" fill="currentColor" />
            立即扫描
          </button>
        </div>
      </header>

      <div v-if="activeTab === 'overview'" class="page-content">
        <section class="metric-grid" aria-label="关键指标">
          <article class="metric"><div class="metric-icon green"><BookOpen :size="19" /></div><span>启用知识库</span><strong>{{ activeMonitors }}</strong><small>共 {{ monitors.length }} 项配置</small></article>
          <article class="metric"><div class="metric-icon amber"><Bell :size="19" /></div><span>通知接收人</span><strong>{{ activeRecipients }}</strong><small>用户与群聊</small></article>
          <article class="metric"><div class="metric-icon blue"><FileText :size="19" /></div><span>最近扫描文档</span><strong>{{ latestRun?.scanned ?? 0 }}</strong><small>{{ formatTime(latestRun?.finishedAt) }}</small></article>
          <article class="metric"><div class="metric-icon coral"><Activity :size="19" /></div><span>最近发现更新</span><strong>{{ latestRun?.changed ?? 0 }}</strong><small>已通知 {{ latestRun?.notified ?? 0 }} 次</small></article>
        </section>

        <section class="content-section">
          <div class="section-heading"><div><h2>最近更新</h2><p>按飞书文件元数据的最后修改时间排序</p></div><button class="text-button" type="button" @click="activeTab = 'runs'">查看运行记录<ChevronRight :size="16" /></button></div>
          <div v-if="changes.length" class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>文档</th><th>知识库</th><th>最后编辑人</th><th>更新时间</th></tr></thead>
              <tbody><tr v-for="change in changes.slice(0, 8)" :key="change.eventId"><td><a :href="change.documentUrl" target="_blank" rel="noreferrer">{{ change.documentTitle }}</a></td><td>{{ change.wikiName }}</td><td>{{ change.editorName || change.editorId || '未知' }}</td><td>{{ formatTime(change.updatedAt) }}</td></tr></tbody>
            </table>
          </div>
          <div v-else class="empty-state"><FileText :size="28" /><strong>暂无文档更新</strong><span>首次扫描只建立基线，后续更新会显示在这里</span></div>
        </section>
      </div>

      <div v-else-if="activeTab === 'wiki'" class="page-content">
        <section class="content-section">
          <div class="section-heading"><div><h2>监听知识库</h2><p>扫描知识库中的 docx，正文不会被读取或保存</p></div><button class="button primary" type="button" @click="openSpacePicker"><Plus :size="17" />添加知识库</button></div>
          <div v-if="monitors.length" class="item-list">
            <article v-for="monitor in monitors" :key="monitor.id" class="list-item">
              <div class="item-leading"><div class="square-icon"><BookOpen :size="19" /></div><div><strong>{{ monitor.spaceName }}</strong><span>{{ monitor.rootNodeTitle || '整个知识空间' }} · {{ monitor.spaceId }} · 每 {{ monitor.pollIntervalMinutes || 15 }} 分钟</span></div></div>
              <div class="item-actions"><span :class="['status-pill', monitor.enabled ? 'success' : 'neutral']">{{ monitor.enabled ? '监听中' : '已暂停' }}</span><label class="switch"><input type="checkbox" :checked="monitor.enabled" :aria-label="`${monitor.spaceName}监听开关`" @change="toggleMonitor(monitor)" /><span></span></label><button class="icon-button danger" type="button" title="删除" :aria-label="`删除${monitor.spaceName}`" @click="removeMonitor(monitor)"><Trash2 :size="17" /></button></div>
            </article>
          </div>
          <div v-else class="empty-state"><BookOpen :size="28" /><strong>还没有监听知识库</strong><span>添加后先执行一次扫描建立文档基线</span></div>
        </section>
      </div>

      <div v-else-if="activeTab === 'recipients'" class="page-content">
        <section class="content-section">
          <div class="section-heading"><div><h2>通知接收人</h2><p>可以发送给应用可用范围内的用户或机器人所在群聊</p></div><button class="button primary" type="button" @click="openRecipientPicker"><Plus :size="17" />添加接收人</button></div>
          <div v-if="recipients.length" class="item-list">
            <article v-for="recipient in recipients" :key="recipient.id" class="list-item">
              <div class="item-leading"><div class="avatar-fallback muted">{{ recipient.type === 'chat' ? '群' : recipient.name.slice(0, 1) }}</div><div><strong>{{ recipient.name }}</strong><span>{{ recipient.type === 'chat' ? '群聊' : '用户' }} · {{ recipient.chatId || recipient.openId }}</span></div></div>
              <div class="item-actions"><label class="switch"><input type="checkbox" :checked="recipient.enabled" :aria-label="`${recipient.name}通知开关`" @change="toggleRecipient(recipient)" /><span></span></label><button class="icon-button danger" type="button" title="删除" :aria-label="`删除${recipient.name}`" @click="removeRecipient(recipient)"><Trash2 :size="17" /></button></div>
            </article>
          </div>
          <div v-else class="empty-state"><Users :size="28" /><strong>还没有通知接收人</strong><span>文档更新事件会保留，但不会发送消息</span></div>
        </section>
      </div>

      <div v-else-if="activeTab === 'template'" class="page-content template-layout">
        <section class="content-section editor-section">
          <div class="section-heading"><div><h2>默认消息模板</h2><p>仅支持下方列出的白名单变量</p></div><button class="button primary" type="button" @click="saveTemplate"><Check :size="17" />保存模板</button></div>
          <template v-if="currentTemplate">
            <label class="field"><span>模板名称</span><input v-model="currentTemplate.name" type="text" /></label>
            <label class="field"><span>消息内容</span><textarea v-model="currentTemplate.content" rows="13"></textarea></label>
            <div class="variable-list"><code v-for="name in ['document_title','document_url','updated_at','editor_name','editor_id','wiki_name']" :key="name">{{ variableToken(name) }}</code></div>
            <button class="button secondary" type="button" @click="previewTemplate"><MessageSquareText :size="17" />生成预览</button>
          </template>
        </section>
        <aside class="preview-panel"><div class="preview-title"><span>消息预览</span><small>飞书文本消息</small></div><pre>{{ preview || '点击“生成预览”查看模板渲染结果' }}</pre></aside>
      </div>

      <div v-else-if="activeTab === 'changes'" class="page-content">
        <section class="content-section">
          <div class="section-heading"><div><h2>文档更新记录</h2><p>只展示更新时间、最后编辑人和文档链接，不保存文档正文。</p></div><button class="text-button" type="button" @click="loadDashboard"><RefreshCw :size="16" />刷新记录</button></div>
          <div v-if="changes.length" class="data-table-wrap">
            <table class="data-table"><thead><tr><th>文档</th><th>知识库</th><th>操作人</th><th>更新时间</th><th>检测时间</th></tr></thead><tbody><tr v-for="change in changes" :key="change.eventId"><td><a :href="change.documentUrl" target="_blank" rel="noreferrer">{{ change.documentTitle }}</a></td><td>{{ change.wikiName }}</td><td>{{ change.editorName || change.editorId || '未知' }}</td><td>{{ formatTime(change.updatedAt) }}</td><td>{{ formatTime(change.detectedAt) }}</td></tr></tbody></table>
          </div>
          <div v-else class="empty-state"><FileText :size="28" /><strong>暂无更新记录</strong><span>文档更新后，将在这里显示最后编辑人和更新时间</span></div>
        </section>
      </div>

      <div v-else class="page-content">
        <section class="content-section">
          <div class="section-heading"><div><h2>运行记录</h2><p>Cron 与手动任务共用相同扫描链路</p></div></div>
          <div v-if="runs.length" class="data-table-wrap">
            <table class="data-table"><thead><tr><th>开始时间</th><th>来源</th><th>状态</th><th>扫描</th><th>更新</th><th>通知</th><th>失败</th></tr></thead><tbody><tr v-for="run in runs" :key="run.runId"><td>{{ formatTime(run.startedAt) }}</td><td>{{ run.trigger === 'cron' ? '定时' : '手动' }}</td><td><span :class="['status-pill', run.status === 'success' ? 'success' : run.status === 'failed' ? 'error' : 'neutral']">{{ statusLabel(run.status) }}</span></td><td>{{ run.scanned }}</td><td>{{ run.changed }}</td><td>{{ run.notified }}</td><td>{{ run.failed }}</td></tr></tbody></table>
          </div>
          <div v-else class="empty-state"><Clock3 :size="28" /><strong>暂无运行记录</strong><span>点击右上角“立即扫描”开始第一次运行</span></div>
        </section>
      </div>
    </section>

    <div v-if="spaceDialog" class="dialog-backdrop" @click.self="spaceDialog = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="space-dialog-title"><div class="dialog-header"><div><h2 id="space-dialog-title">选择知识库</h2><p>显示当前授权用户可访问的知识空间</p></div><button class="icon-button" type="button" aria-label="关闭" @click="spaceDialog = false"><X :size="19" /></button></div><div class="dialog-list"><button v-for="space in spaces" :key="space.spaceId" class="choice-row" type="button" @click="addSpace(space)"><div><strong>{{ space.name }}</strong><span>{{ space.description || space.spaceId }}</span></div><ChevronRight :size="18" /></button><div v-if="!spaces.length" class="empty-state compact">未查询到可访问知识库</div></div></section>
    </div>

    <div v-if="nodeDialog" class="dialog-backdrop" @click.self="nodeDialog = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="node-dialog-title">
        <div class="dialog-header">
          <div><h2 id="node-dialog-title">选择监听范围</h2><p>{{ nodeSpace?.name }} · {{ nodeParents.length ? nodeParents.map((item) => item.title).join(' / ') : '知识库根目录' }}</p></div>
          <button class="icon-button" type="button" aria-label="关闭" @click="nodeDialog = false"><X :size="19" /></button>
        </div>
        <div class="dialog-toolbar">
          <button v-if="nodeParents.length" class="button secondary" type="button" :disabled="nodeLoading" @click="leaveNode"><ChevronRight class="rotate-left" :size="16" />返回上级</button>
          <button class="button primary" type="button" :disabled="nodeLoading" @click="chooseMonitor()"><BookOpen :size="16" />监听整个{{ nodeParents.length ? '当前目录' : '知识库' }}</button>
        </div>
        <div class="dialog-list">
          <button v-for="node in nodeItems" :key="node.nodeToken" class="choice-row" type="button" @click="enterNode(node)">
            <div><strong>{{ node.title }}</strong><span>{{ node.objType }}{{ node.hasChild ? ' · 包含子节点' : '' }}</span></div>
            <ChevronRight :size="18" />
          </button>
          <button v-if="nodeCursor" class="text-button" type="button" :disabled="nodeLoading" @click="loadSpaceNodes(true)">{{ nodeLoading ? '加载中…' : '加载更多' }}</button>
          <div v-if="!nodeItems.length && !nodeLoading" class="empty-state compact">当前目录没有可访问节点</div>
          <div v-if="nodeLoading" class="empty-state compact"><LoaderCircle class="spin" :size="20" />正在加载节点</div>
        </div>
      </section>
    </div>

    <div v-if="recipientDialog" class="dialog-backdrop" @click.self="recipientDialog = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="recipient-dialog-title"><div class="dialog-header"><div><h2 id="recipient-dialog-title">添加通知接收人</h2><p>用户需在应用可用范围内，机器人需已加入群聊</p></div><button class="icon-button" type="button" aria-label="关闭" @click="recipientDialog = false"><X :size="19" /></button></div><div class="segmented"><button :class="{ active: candidateType === 'user' }" type="button" @click="loadCandidates('user')">用户</button><button :class="{ active: candidateType === 'chat' }" type="button" @click="loadCandidates('chat')">群聊</button></div><label class="search-field"><Search :size="17" /><input v-model="searchQuery" type="search" placeholder="筛选名称" @input="loadCandidates()" /></label><div class="dialog-list"><button v-for="candidate in candidates" :key="candidate.id" class="choice-row" type="button" @click="addRecipient(candidate)"><div><strong>{{ candidate.name }}</strong><span>{{ candidate.description || candidate.id }}</span></div><Plus :size="18" /></button><button v-if="candidateCursor" class="text-button" type="button" @click="loadCandidates(candidateType, true)">加载更多</button><div v-if="!candidates.length" class="empty-state compact">没有匹配的对象</div></div></section>
    </div>

    <div v-if="toast" :class="['toast', toast.type]" role="status"><Check v-if="toast.type === 'success'" :size="18" /><Bell v-else :size="18" />{{ toast.message }}</div>
  </div>
</template>
