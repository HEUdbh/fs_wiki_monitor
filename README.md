# Feishu Wiki Monitor

基于 Hono、Vue 3、Cloudflare Workers 和 Cloudflare KV 的飞书知识库更新监控工具。

系统通过飞书 OAuth 登录，在可视化控制台中选择要监听的知识库或目录、消息接收人和通知模板；Cloudflare Cron 定时扫描文档元数据，在文档更新时间变化时发送飞书通知。系统只读取文档标题、链接、更新时间和最后编辑人，不读取或保存文档正文。

## 功能

- 飞书 OAuth 登录与管理员权限校验。
- 可视化选择有权限访问的知识库、整个知识空间或指定目录。
- 定时扫描 `docx` 文档，也可在控制台手动触发扫描。
- 根据文档最后更新时间判断是否更新，记录最后编辑人和更新时间。
- 首次扫描仅建立快照，后续更新才发送通知。
- 支持向飞书用户或群聊发送通知。
- 支持在线编辑、预览通知模板，内置以下变量：
  - `{{document_title}}`
  - `{{document_url}}`
  - `{{updated_at}}`
  - `{{editor_name}}`
  - `{{editor_id}}`
  - `{{wiki_name}}`
- 提供知识库配置、接收人管理、模板管理、更新记录和运行记录控制台。
- 使用 KV 保存授权信息、监控配置、文档快照和运行记录。
- 使用运行锁、通知幂等键和接口限流减少并发扫描与重复通知。

## 部署

### 1. 环境要求

- Node.js 20 或更高版本
- npm
- Cloudflare 账号及 Workers 权限
- 飞书企业自建应用
- 一个可由 Cloudflare Workers 使用的域名，或默认的 `workers.dev` 域名

安装依赖并登录 Cloudflare：

```bash
npm install
npx wrangler login
```

### 2. 配置飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，启用网页应用和机器人能力，并配置应用可用范围。

应用需要具备以下能力对应的权限：

- 获取当前登录用户信息；
- 获取用户可访问的知识空间和 Wiki 节点；
- 读取云文档元数据；
- 获取用户、部门用户和群聊信息；
- 以应用身份向用户或群聊发送消息；
- 获取长期授权所需的 `offline_access`。

飞书后台的 OAuth 重定向 URL 必须与 Worker 配置完全一致：

```text
https://你的域名/api/auth/callback
```

应用权限变更后，需要重新发布应用版本，并由企业管理员审批。定时任务读取知识库时，完成 OAuth 登录的管理员必须拥有目标知识库访问权限；发送群消息时，应用机器人必须已加入目标群聊。

### 3. 创建 Cloudflare KV

创建正式和本地预览使用的 KV Namespace：

```bash
npx wrangler kv namespace create FEISHU_MONITOR_KV
npx wrangler kv namespace create FEISHU_MONITOR_KV --preview
```

记录命令返回的 `id` 和 `preview_id`。

### 4. 创建 Wrangler 配置

真实的 `wrangler.jsonc` 包含域名、KV 标识及部署实例配置，已被 Git 忽略。首次部署时复制公开模板：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

macOS 或 Linux：

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

编辑 `wrangler.jsonc`：

- 将 KV 的 `id`、`preview_id` 替换为上一步的值；
- 将 `APP_ORIGIN` 改为实际访问地址；
- 如使用自定义域名，将 `workers_dev` 改为 `false`，并增加 `routes`：

```jsonc
"routes": [
  {
    "pattern": "monitor.example.com",
    "custom_domain": true
  }
]
```

- 模板默认按 UTC 配置 Cron：上海时间每天 `09:00-22:00` 每 30 分钟执行监控，`22:30` 执行 KV 历史数据清理；手动扫描不受该时间段限制。

自定义域名必须位于当前 Cloudflare 账号管理且已接入 Cloudflare 的 Zone 中；否则先使用 `workers.dev` 地址完成部署和 OAuth 配置。

### 5. 设置生产 Secrets

以下值不得写入 README、源码或 `wrangler.jsonc`：

```bash
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put FEISHU_REDIRECT_URI
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put ADMIN_OPEN_IDS
```

说明：

- `FEISHU_REDIRECT_URI`：完整 OAuth 回调地址，例如 `https://monitor.example.com/api/auth/callback`。
- `TOKEN_ENCRYPTION_KEY`：用于加密 KV 中的飞书 Token，建议使用高强度随机值。
- `SESSION_SIGNING_KEY`：用于签名登录 Session，必须与加密密钥不同。
- `ADMIN_OPEN_IDS`：允许进入管理控制台的飞书 Open ID；多个值使用英文逗号分隔。

可使用以下方式生成随机密钥：

```bash
openssl rand -base64 32
```

Windows 没有 OpenSSL 时，可使用密码管理器生成至少 32 字节的随机字符串。

### 6. 部署 Worker

```bash
npm run typecheck
npm test
npm run deploy
```

部署完成后：

1. 访问 Worker 域名并使用飞书登录；
2. 确认当前账号位于 `ADMIN_OPEN_IDS`；
3. 在控制台选择监听的知识库或目录；
4. 添加通知用户或群聊；
5. 编辑并预览消息模板；
6. 点击“立即扫描”建立首次快照；
7. 在 Cloudflare Workers 控制台确认 Cron Trigger 已启用。

首次扫描默认不通知。后续文档更新时间变化时，系统才会产生更新记录并发送消息。

### 7. 提交前安全检查

项目已忽略本地配置、环境变量、Wrangler 状态目录、构建产物、密钥和证书。提交前仍应检查暂存区：

```bash
git status --ignored
git diff --cached
```

不要提交以下内容：

- `wrangler.jsonc`
- `.dev.vars`、`.env` 及其环境变体
- 飞书 App Secret、Access Token、Refresh Token
- `TOKEN_ENCRYPTION_KEY`、`SESSION_SIGNING_KEY`
- 管理员 Open ID、真实 KV Namespace ID 和私钥文件

如果敏感值曾经进入 Git 历史，仅修改 `.gitignore` 无法将其移除；应立即轮换相关凭证，并使用 Git 历史清理工具处理已提交内容。

## 二次开发

### 本地运行

复制本地变量模板：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

macOS 或 Linux：

```bash
cp .dev.vars.example .dev.vars
```

填写本地飞书应用信息后启动：

```bash
npm install
npm run dev
```

本地 OAuth 回调地址通常为：

```text
http://localhost:5173/api/auth/callback
```

该地址也必须加入飞书应用的重定向 URL 白名单。本地开发默认使用 Wrangler 的本地 KV；如在 `wrangler.jsonc` 的 KV Binding 中设置 `"remote": true`，本地操作会直接访问远程 KV，请谨慎使用。

### 项目结构

```text
src/
├─ api/             Hono API 路由
├─ auth/            OAuth、Session 和 Token 加密
├─ feishu/          飞书开放平台客户端与数据适配
├─ monitor/         Wiki 遍历、更新检测、模板渲染和通知
├─ repositories/    KV 配置、快照和运行记录访问层
├─ shared/          类型、错误与统一响应
├─ web/             Vue 3 控制台
├─ app.ts           Hono 应用及中间件
└─ index.ts         Worker fetch 与 scheduled 入口
```

### 扩展方式

- 新增后端接口：在 `src/api/` 创建或修改 Hono 路由，并在 `src/app.ts` 注册；管理接口应继续使用 Session、管理员和 CSRF 校验。
- 新增飞书能力：在 `src/feishu/client.ts` 封装请求，将飞书原始响应转换为项目内部类型，不要让 Vue 页面直接依赖飞书响应结构。
- 修改扫描规则：从 `src/monitor/runner.ts` 和 `src/monitor/traverse.ts` 扩展，保持首次扫描建基线、单文档失败不阻断整轮任务和通知幂等规则。
- 修改数据结构：在 `src/shared/types.ts` 定义类型，通过 `src/repositories/` 访问 KV；避免在路由和页面中直接拼接 KV Key。
- 扩展消息模板：修改 `src/monitor/template.ts`，变量必须采用白名单替换，不执行任意 JavaScript 表达式。
- 扩展控制台：Vue 页面入口位于 `src/web/main.ts`，当前主要界面位于 `src/web/App.vue`，请求封装位于 `src/web/api.ts`。
- 修改定时周期：调整本地 `wrangler.jsonc` 中的 `triggers.crons`；业务逻辑统一调用 `runWikiMonitor()`，保证 Cron 与手动扫描行为一致。

新增配置项时，应同时更新：

1. `src/bindings.ts` 中的 Worker Binding 类型；
2. `wrangler.example.jsonc` 中的非敏感默认值，或 `.dev.vars.example` 中的 Secret 占位符；
3. README 的部署说明；
4. 对应单元测试。

### 开发命令

```bash
npm run dev          # 本地开发
npm run typecheck    # TypeScript 类型检查
npm test             # 运行 Vitest 测试
npm run build        # 生产构建
npm run preview      # 本地预览生产构建
npm run cf-typegen   # 生成 Cloudflare Binding 类型
npm run deploy       # 构建并部署 Worker
```

提交改动前至少运行：

```bash
npm run typecheck
npm test
npm run build
```
