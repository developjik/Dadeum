import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { SyncStateDb } from '../../core/store/syncState'
import { pullFullSpace } from './pullService'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clientFor(): ConfluenceClient {
  return new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    email: 'dev@acme.io',
    apiToken: 'tok',
    sleep: () => Promise.resolve(),
    fetchImpl: (async (input: Request | string | URL) => {
      const url = String(input)
      if (url.includes('/spaces/sp-dev/pages'))
        return jsonResponse({
          results: [{ id: '900001', title: '개발 노트', version: { number: 1 }, parentId: null }],
          _links: {},
        })
      if (url.includes('/spaces/sp-mkt/pages'))
        return jsonResponse({
          results: [{ id: '900002', title: '마케팅 계획', version: { number: 5 }, parentId: null }],
          _links: {},
        })
      if (url.includes('/api/v2/pages/900001'))
        return jsonResponse({
          id: '900001',
          title: '개발 노트',
          version: { number: 1 },
          body: { storage: { value: '<p>DEV 본문</p>' } },
        })
      if (url.includes('/api/v2/pages/900002'))
        return jsonResponse({
          id: '900002',
          title: '마케팅 계획',
          version: { number: 5 },
          body: { storage: { value: '<p>MKT 본문</p>' } },
        })
      if (url.includes('/child/attachment')) return jsonResponse({ results: [] })
      return jsonResponse({ results: [] })
    }) as unknown as typeof fetch,
  })
}

describe('다중 스페이스 동시 연결(AC-10, ef-14)', () => {
  it('두 스페이스를 같은 워크스페이스에 독립 폴더·독립 상태로 pull한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'multi-space-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    const client = clientFor()

    const dev = await pullFullSpace({
      client,
      space: { id: 'sp-dev', key: 'DEV', name: '개발' },
      workspaceRoot: root,
      db,
    })
    const mkt = await pullFullSpace({
      client,
      space: { id: 'sp-mkt', key: 'MKT', name: '마케팅' },
      workspaceRoot: root,
      db,
    })

    expect(dev.pages).toBe(1)
    expect(mkt.pages).toBe(1)

    // 독립 폴더
    expect(existsSync(join(root, 'spaces/DEV/개발-노트/index.md'))).toBe(true)
    expect(existsSync(join(root, 'spaces/MKT/마케팅-계획/index.md'))).toBe(true)

    // 독립 상태: 서로의 페이지가 섞이지 않는다
    expect(db.listPagesBySpace('DEV').map((p) => p.pageId)).toEqual(['900001'])
    expect(db.listPagesBySpace('MKT').map((p) => p.pageId)).toEqual(['900002'])

    // 본문 분리
    expect(readFileSync(join(root, 'spaces/DEV/개발-노트/index.md'), 'utf8')).toContain('DEV 본문')
    expect(readFileSync(join(root, 'spaces/MKT/마케팅-계획/index.md'), 'utf8')).toContain(
      'MKT 본문',
    )
    db.close()
  })
})
