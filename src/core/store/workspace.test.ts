import { describe, expect, it } from 'vitest'
import {
  isSyncTarget,
  pageSlug,
  parsePageFile,
  renderPageFile,
  slugify,
  spaceDir,
  workspaceLayout
} from './workspace'

describe('workspaceLayout', () => {
  it('루트 아래 규약 경로를 만든다', () => {
    const layout = workspaceLayout('/Users/dev/ws')
    expect(layout.stateDb).toBe('/Users/dev/ws/.sync/sync-state.db')
    expect(layout.trashDir).toBe('/Users/dev/ws/.sync/trash')
    expect(spaceDir(layout, 'DEV')).toBe('/Users/dev/ws/spaces/DEV')
  })
})

describe('slugify', () => {
  it('한글 제목을 NFC로 보존한다', () => {
    const decomposed = '가이드'
    expect(slugify(decomposed)).toBe('가이드')
    expect(slugify('배포 가이드')).toBe('배포-가이드')
  })

  it('OS 금지문자를 제거한다', () => {
    expect(slugify('a/b:c*d?"e<f>g|h')).toBe('a-b-c-d-e-f-g-h')
    expect(slugify('  여러   공백  ')).toBe('여러-공백')
  })

  it('80자로 잘라내고 빈 제목은 page로 폴백한다', () => {
    expect(slugify('x'.repeat(120))).toHaveLength(80)
    expect(slugify('///')).toBe('page')
  })

  it('OS 예약명을 회피한다(F-8)', () => {
    expect(pageSlug('CON', '123456', new Set())).toBe('CON-p')
    expect(pageSlug('nul', '123456', new Set())).toBe('nul-p')
  })
})

describe('pageSlug 충돌 병합(F1)', () => {
  it('충돌이 없으면 기본 슬러그를 유지한다', () => {
    expect(pageSlug('가이드', '900719', new Set(['다른']))).toBe('가이드')
  })

  it('동일 부모 충돌 시 pageId 하위 6자를 접미한다', () => {
    const siblings = new Set(['가이드'])
    expect(pageSlug('가이드', '900719925474', siblings)).toBe('가이드-925474')
  })
})

describe('isSyncTarget allowlist(F3/F-12)', () => {
  it('index.md와 attachments만 대상이다', () => {
    expect(isSyncTarget('spaces/DEV/가이드/index.md')).toBe(true)
    expect(isSyncTarget('spaces/DEV/가이드/attachments/logo.png')).toBe(true)
  })

  it('엔진 파일·백업·보조 파일은 제외된다', () => {
    expect(isSyncTarget('.sync/sync-state.db')).toBe(false)
    expect(isSyncTarget('confluence.yaml')).toBe(false)
    expect(isSyncTarget('spaces/DEV/_space.yaml')).toBe(false)
    expect(isSyncTarget('spaces/DEV/가이드/index.local-20260912.md')).toBe(false)
    expect(isSyncTarget('spaces/DEV/가이드/롤백.remote.md')).toBe(false)
    expect(isSyncTarget('spaces/DEV/가이드/본문.md')).toBe(false)
  })

  it('경로 탈출(QA P1)을 차단한다', () => {
    expect(isSyncTarget('spaces/DEV/x/attachments/../../../../etc/passwd')).toBe(false)
    expect(isSyncTarget('spaces/DEV/x/attachments/../.sync/sync-state.db')).toBe(false)
    expect(isSyncTarget('spaces/DEV/../..//etc/passwd')).toBe(false)
    expect(isSyncTarget('..\\..\\etc\\passwd')).toBe(false)
    expect(isSyncTarget('index.md')).toBe(false)
    expect(isSyncTarget('attachments/evil.md')).toBe(false)
  })
})

describe('frontmatter 코덱', () => {
  const meta = {
    pageId: '9007199254740993',
    spaceKey: 'DEV',
    title: '배포: 가이드 "v2"',
    version: 7,
    parentId: null,
    url: 'https://acme.atlassian.net/wiki/spaces/DEV/pages/9007199254740993',
    updatedAt: '2026-09-12T00:00:00.000Z',
    syncedAt: '2026-09-12T01:00:00.000Z'
  }

  it('렌더→파싱 왕복이 손실 없다', () => {
    const raw = renderPageFile(meta, '# 본문\n\n- 항목')
    const parsed = parsePageFile(raw)
    expect(parsed.meta).toEqual(meta)
    expect(parsed.body).toBe('# 본문\n\n- 항목')
  })

  it('콜론이 포함된 값도 안전하게 인용된다', () => {
    const raw = renderPageFile(meta, 'x')
    expect(raw).toContain(`title: ${JSON.stringify('배포: 가이드 "v2"')}`)
    expect(parsePageFile(raw).meta.title).toBe('배포: 가이드 "v2"')
  })

  it('frontmatter가 없는 파일은 거부한다', () => {
    expect(() => parsePageFile('그냥 본문')).toThrow(/frontmatter/)
  })
})
