export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'FEISHU_PERMISSION_DENIED'
  | 'FEISHU_API_ERROR'
  | 'WIKI_FETCH_FAILED'
  | 'DOCUMENT_METADATA_FAILED'
  | 'MESSAGE_SEND_FAILED'
  | 'EDITOR_UNAVAILABLE'
  | 'KV_READ_FAILED'
  | 'KV_WRITE_FAILED'
  | 'MONITOR_LOCKED'
  | 'RATE_LIMITED'
  | 'CONFIGURATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : '未知错误'
  if (message.startsWith('KV read failed:')) return new AppError('KV_READ_FAILED', '读取 Cloudflare KV 失败', 503, error)
  if (message.startsWith('KV write failed:')) return new AppError('KV_WRITE_FAILED', '写入 Cloudflare KV 失败', 503, error)
  return new AppError('INTERNAL_ERROR', message, 500)
}
