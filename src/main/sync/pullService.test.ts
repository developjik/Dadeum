import { mkdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { SyncStateDb } from '../../core/store/syncState'
import { isSyncTarget } from '../../core/store/workspace'
import { pullFullSpace } from './pullService'

function jsonResponse(init: { status?: number; body?: unknown }): Response {
  return new Response(init.body === undefined ? undefined : JSON.stringify(init.body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function fakeClient(): ConfluenceClient {
  const attachments = [
    { id: 'att-1', title: 'logo.png', metadata: { mediaType: { name: 'image/png' } } }
  ]
  return new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    email: 'dev@acme.io',
    apiToken: 'tok',
    sleep: () => Promise.resolve(),
    fetchImpl: (async (input: Request | string | URL) => {
      const url = String(input)
      if (url.includes('/api/v2/spaces/sp-1/pages')) {
        return jsonResponse({
          body: {
            results: [
              { id: '990001', title: '루트 페이지', version: { number: 3 }, parentId: null },
              { id: '990002', title: '하위 페이지', version: { number: 1 }, parentId: '990001' },
              { id: '990003', title: '루트 페이지', version: { number: 2 }, parentId: null } // 제목 충돌(F1)
            ],
            _links: {}
          }
        })
      }
      if (url.includes('/api/v2/pages/990001')) {
        return jsonResponse({ body: { id: '990001', title: '루트 페이지', version: { number: 3 }, body: { storage: { value: '<h1>루트</h1><p>내용</p>' } } } })
      }
      if (url.includes('/api/v2/pages/990002')) {
        return jsonResponse({ body: { id: '990002', title: '하위 페이지', version: { number: 1 }, body: { storage: { value: '<p>하위 본문</p>' } } } })
      }
      if (url.includes('/api/v2/pages/990003')) {
        return jsonResponse({ body: { id: '990003', title: '루트 페이지', version: { number: 2 }, body: { storage: { value: '<p>두 번째 루트</p>' } } } })
      }
      if (url.includes('/content/990001/child/attachment?')) {
        return jsonResponse({ body: { results: attachments } })
      }
      if (url.includes('/child/attachment?')) {
        return jsonResponse({ body: { results: [] } })
      }
      if (url.includes('/download')) {
        return new Response(Buffer.from('PNG-DATA'), { status: 200 })
      }
      return jsonResponse({ status: 404, body: {} })
    }) as unknown as typeof fetch
  })
}

describe('pullFullSpace(연결 시 전체 pull, ef-13)', () => {
  it('페이지 트리를 중첩 디렉터리로 복제하고 첨부를 내려받는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'confluence-pull-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))

    const result = await pullFullSpace({
      client: fakeClient(),
      space: { id: 'sp-1', key: 'DEV', name: '개발' },
      workspaceRoot: root,
      db
    })

    expect(result.pages).toBe(3)
    expect(result.attachments).toBe(1)

    // 계층 = 페이지 트리: 루트 아래 하위 페이지가 중첩된다
    expect(existsSync(join(root, 'spaces/DEV/루트-페이지/index.md'))).toBe(true)
    expect(existsSync(join(root, 'spaces/DEV/루트-페이지/하위-페이지/index.md'))).toBe(true)
    // 제목 충돌(F1): 동일 부모의 두 번째 '루트 페이지'는 pageId 접미로 분리
    expect(existsSync(join(root, 'spaces/DEV/루트-페이지-990003/index.md'))).toBe(true)

    // frontmatter + 변환 본문
    const raw = readFileSync(join(root, 'spaces/DEV/루트-페이지/index.md'), 'utf8')
    expect(raw).toContain('pageId: "990001"')
    expect(raw).toContain('# 루트')

    // 첨부
    expect(existsSync(join(root, 'spaces/DEV/루트-페이지/attachments/logo.png'))).toBe(true)

    // 정준 원천 DB
    const p1 = db.getPage('990001')
    expect(p1?.path).toBe('spaces/DEV/루트-페이지/index.md')
    expect(p1?.version).toBe(3)

    // 생성된 모든 index.md는 동기 대상 allowlist에 부합한다
    expect(isSyncTarget('spaces/DEV/루트-페이지/index.md')).toBe(true)
    expect(isSyncTarget('spaces/DEV/루트-페이지/attachments/logo.png')).toBe(true)

    db.close()
  })
})
