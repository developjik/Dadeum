import { describe, expect, it } from 'vitest'
import { fileHashOf } from './hash'
import { canonicalMarkdownBody, pageContentHashOf, pageHashMatches } from './pageFingerprint'

const RAW =
  '---\npageId: "1001"\nspaceKey: "DEV"\ntitle: "제목"\nversion: 2\nparentId: null\nurl: "u"\nupdatedAt: null\nsyncedAt: null\n---\n\n본문'

describe('canonicalMarkdownBody(정규형)', () => {
  it('CRLF·CR·EOF 개행 수 차이를 흡수한다', () => {
    expect(canonicalMarkdownBody('가\r\n나\r마')).toBe('가\n나\n마\n')
    expect(canonicalMarkdownBody('가\n')).toBe(canonicalMarkdownBody('가\n\n\n'))
    expect(canonicalMarkdownBody('가\n\n\n')).toBe('가\n')
  })
})

describe('pageContentHashOf(동기 의미 지문)', () => {
  it('앱 관리 필드(version·syncedAt) 변화는 변경이 아니다', () => {
    const edited = RAW.replace('version: 2', 'version: 9').replace(
      'syncedAt: null',
      'syncedAt: "2026-09-14T00:00:00.000Z"',
    )
    expect(pageContentHashOf(edited)).toBe(pageContentHashOf(RAW))
  })

  it('본문 개행 표기만 바뀐 편집은 변경이 아니다(편집기 노이즈 제거)', () => {
    const crlf = RAW.replace('본문', '줄1\r\n줄2')
    const lf = RAW.replace('본문', '줄1\n줄2')
    expect(pageContentHashOf(crlf)).toBe(pageContentHashOf(lf))
  })

  it('본문·제목 편집은 해시가 달라진다', () => {
    expect(pageContentHashOf(RAW.replace('본문', '바뀐 본문'))).not.toBe(pageContentHashOf(RAW))
    expect(pageContentHashOf(RAW.replace('title: "제목"', 'title: "새 제목"'))).not.toBe(
      pageContentHashOf(RAW),
    )
  })
})

describe('pageHashMatches(레거시 호환 판정)', () => {
  it('v3 정규화 해시와 일치하면 unchanged다', () => {
    expect(pageHashMatches(RAW, pageContentHashOf(RAW))).toBe(true)
  })

  it('v2까지의 전체-파일 해시도 unchanged로 인정한다(업그레이드 직후 오판 방지)', () => {
    expect(pageHashMatches(RAW, fileHashOf(RAW))).toBe(true)
  })

  it('본문이 바뀌면 어느 체계의 해시와도 불일치다', () => {
    const edited = RAW.replace('본문', '다른 본문')
    expect(pageHashMatches(edited, pageContentHashOf(RAW))).toBe(false)
    expect(pageHashMatches(edited, fileHashOf(RAW))).toBe(false)
    expect(pageHashMatches(RAW, null)).toBe(false)
  })

  it('frontmatter가 깨진 파일은 파싱 불가 = 변경된 것으로 본다(보호 우선)', () => {
    // 레거시(전체 파일 바이트) 해시 비교가 먼저이므로 정규화 해시 기준으로만 판정된다
    expect(pageHashMatches('broken', pageContentHashOf(RAW))).toBe(false)
  })
})
