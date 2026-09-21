import { AppError } from '../shared/errors'

const ALLOWED_VARIABLES = new Set([
  'document_title',
  'document_url',
  'updated_at',
  'editor_name',
  'editor_id',
  'wiki_name',
])

const VARIABLE_PATTERN = /{{([\s\S]*?)}}/g

export function validateTemplate(content: string): void {
  if (!content.trim()) throw new AppError('INVALID_REQUEST', '模板内容不能为空', 400)
  if (content.length > 20_000) throw new AppError('INVALID_REQUEST', '模板内容不能超过 20000 字符', 400)
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const variable = match[1].trim()
    if (!ALLOWED_VARIABLES.has(variable)) {
      throw new AppError('INVALID_REQUEST', `未知模板变量：${variable || '(空)'}`, 400)
    }
  }
}

export function renderTemplate(content: string, variables: Record<string, string | undefined>): string {
  validateTemplate(content)
  return content.replace(VARIABLE_PATTERN, (_, key: string) => variables[key.trim()] || '未知')
}
