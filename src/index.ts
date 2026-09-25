import app from './app'
import type { CloudflareBindings } from './bindings'
import { cleanupKvData } from './maintenance/cleanup'
import { runWikiMonitor } from './monitor/runner'

export const MONITOR_CRONS = ['0,30 1-13 * * *', '0 14 * * *'] as const
export const CLEANUP_CRON = '30 14 * * *'

export default {
  fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx)
  },

  scheduled(controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) {
    if (controller.cron === CLEANUP_CRON) {
      ctx.waitUntil(cleanupKvData(env))
      return
    }
    if (!(MONITOR_CRONS as readonly string[]).includes(controller.cron)) return
    ctx.waitUntil(runWikiMonitor(env, { trigger: 'cron' }))
  },
}
