import { Hono } from 'hono'
import type { AppEnv } from '../bindings'
import { consumeOAuthState, createAuthorizationUrl, exchangeAuthorizationCode } from '../auth/oauth'
import { createSession, destroySession, readSession, requireCsrf, requireSession } from '../auth/session'
import { AppError } from '../shared/errors'
import { ok } from '../shared/response'

export const authRoutes = new Hono<AppEnv>()

authRoutes.get('/login', async (c) => c.redirect(await createAuthorizationUrl(c, c.req.query('returnTo'))))

authRoutes.get('/callback', async (c) => {
  const error = c.req.query('error')
  if (error) {
    const state = c.req.query('state')
    if (!state || !(await consumeOAuthState(c, state))) throw new AppError('INVALID_REQUEST', 'OAuth state 无效或已过期', 400)
    return c.redirect(`/?auth=${encodeURIComponent(error)}`)
  }
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) throw new AppError('INVALID_REQUEST', 'OAuth 回调缺少 code 或 state', 400)
  const result = await exchangeAuthorizationCode(c, code, state)
  await createSession(c, result.user)
  if (result.user.isAdmin) return c.redirect(result.returnTo)
  const returnUrl = new URL(result.returnTo, c.env.APP_ORIGIN)
  returnUrl.searchParams.set('auth', 'forbidden')
  return c.redirect(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`)
})

authRoutes.get('/me', async (c) => {
  const session = await readSession(c)
  return ok(c, session ? {
    authenticated: true,
    user: {
      userId: session.userId,
      openId: session.openId,
      name: session.name,
      avatarUrl: session.avatarUrl,
      isAdmin: session.isAdmin,
      csrfToken: session.csrfToken,
    },
  } : { authenticated: false, user: null })
})

authRoutes.post('/logout', requireSession, requireCsrf, async (c) => {
  await destroySession(c)
  return ok(c, { loggedOut: true })
})
