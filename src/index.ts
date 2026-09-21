import app from './app'
import type { CloudflareBindings } from './bindings'
import { runWikiMonitor } from './monitor/runner'

export default {
  fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx)
  },

  scheduled(_controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) {
    ctx.waitUntil(runWikiMonitor(env, { trigger: 'cron' }))
  },
}
