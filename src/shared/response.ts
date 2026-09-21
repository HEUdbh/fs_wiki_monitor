import type { Context } from 'hono'
import type { AppEnv } from '../bindings'
import { toAppError } from './errors'

export function ok<T>(c: Context<AppEnv>, data: T, status: 200 | 201 | 202 = 200) {
  return c.json({ success: true as const, data }, status)
}

export function fail(c: Context<AppEnv>, error: unknown) {
  const appError = toAppError(error)
  return c.json(
    {
      success: false as const,
      error: {
        code: appError.code,
        message: appError.message,
        requestId: c.get('requestId'),
      },
    },
    appError.status as 400,
  )
}
