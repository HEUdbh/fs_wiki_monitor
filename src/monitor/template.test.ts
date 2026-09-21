import { describe, expect, it } from 'vitest'
import { AppError } from '../shared/errors'
import { renderTemplate, validateTemplate } from './template'

describe('notification template', () => {
  it('renders every supported variable', () => {
    const result = renderTemplate(
      '{{document_title}}|{{wiki_name}}|{{editor_name}}|{{updated_at}}|{{document_url}}',
      {
        document_title: '接口设计',
        wiki_name: '研发知识库',
        editor_name: '张三',
        updated_at: '2026-09-21 12:00:00',
        document_url: 'https://example.feishu.cn/wiki/abc',
      },
    )
    expect(result).toContain('接口设计|研发知识库|张三')
  })

  it('uses an explicit unknown marker for missing values', () => {
    expect(renderTemplate('{{editor_name}}', {})).toBe('未知')
  })

  it('rejects expression-like or unknown variables', () => {
    expect(() => validateTemplate('{{process_env}}')).toThrow(AppError)
    expect(() => validateTemplate('{{user.name}}')).toThrow(AppError)
    expect(() => validateTemplate('{{ editor_name || "匿名" }}')).toThrow(AppError)
  })
})
