export interface ApiErrorPayload {
  code: string
  message: string
  requestId?: string
}

export class ApiError extends Error {
  constructor(public readonly payload: ApiErrorPayload, public readonly status: number) {
    super(payload.message)
  }
}

let csrfToken = ''

export function setCsrfToken(value: string) {
  csrfToken = value
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken && init.method && !['GET', 'HEAD'].includes(init.method) ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init.headers,
    },
  })
  const payload = await response.json() as {
    success: boolean
    data?: T
    error?: ApiErrorPayload
  }
  if (!response.ok || !payload.success) {
    throw new ApiError(payload.error || { code: 'UNKNOWN', message: '请求失败' }, response.status)
  }
  return payload.data as T
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) })
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' })
