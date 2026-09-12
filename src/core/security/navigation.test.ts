import { describe, expect, it } from 'vitest'
import { isAllowedNavigation } from './navigation'

describe('isAllowedNavigation', () => {
  it('file: 스킴은 항상 허용한다', () => {
    expect(isAllowedNavigation('file:///app/out/renderer/index.html')).toBe(true)
    expect(isAllowedNavigation('file:///app/index.html', { dev: true })).toBe(true)
  })

  it('개발 모드에서 localhost http만 허용한다', () => {
    expect(isAllowedNavigation('http://localhost:5173/', { dev: true })).toBe(true)
    expect(isAllowedNavigation('http://127.0.0.1:5173/src/main.tsx', { dev: true })).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173/')).toBe(false)
  })

  it('외부 https는 개발 모드여도 거부한다', () => {
    expect(isAllowedNavigation('https://evil.example.com/', { dev: true })).toBe(false)
    expect(isAllowedNavigation('https://xxx.atlassian.net/wiki/')).toBe(false)
  })

  it('파서가 실패하는 문자열은 거부한다', () => {
    expect(isAllowedNavigation('not a url')).toBe(false)
    expect(isAllowedNavigation('')).toBe(false)
  })
})
