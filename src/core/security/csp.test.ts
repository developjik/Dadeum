import { describe, expect, it } from 'vitest'
import { buildCsp } from './csp'

describe('buildCsp', () => {
  const csp = buildCsp()

  it('script는 self만 허용한다', () => {
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-eval')
  })

  it('위험한 기본 표면을 차단한다', () => {
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('기본 출처는 self로 제한한다', () => {
    expect(csp).toContain("default-src 'self'")
    expect(csp).not.toContain("default-src *")
    expect(csp).not.toContain('http:')
  })

  it('정책은 세미콜론으로 연결된 directive 목록이다', () => {
    const directives = csp.split(';').map((d) => d.trim())
    expect(directives.length).toBeGreaterThanOrEqual(8)
    for (const d of directives) expect(d.length).toBeGreaterThan(0)
  })
})
