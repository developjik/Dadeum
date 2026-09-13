import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { fileHashOf } from '../../core/store/hash'
import { SyncStateDb } from '../../core/store/syncState'
import { SpaceStateMachine } from '../../core/sync/spaceStateMachine'
import { pushApprovedPages } from './pushService'

/**
 * push 동기화 정합 회귀(P1):
 * - 제목은 로컬 frontmatter가 우선한다(원격 rename이 로컬 rename을 묻지 않는다)
 * - 로컬 디렉터리 이동은 parentId 변경 요청으로 push된다
 * - 로컬에서 삭제된 첨부는 원격에서도 정리된다(deletedAttachments 보고)
 */

const REMOTE_PAGE = {
  id: '1001',
  title: '원격 제목',
  version: { number: 2 },
  body: { storage: { value: '<p>서버 원본</p>' } },
}

interface Captured {
  putBody?: Record<string, unknown>
  deletedIds: string[]
  uploads: string[]
}

function makeClient(
  captured: Captured,
  remoteAttachments: Array<{ id: string; title: string }>,
): ConfluenceClient {
  return new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    email: 'dev@acme.io',
    apiToken: 'tok',
    sleep: () => Promise.resolve(),
    fetchImpl: (async (input: Request | string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/api/v2/pages/1001') && method === 'GET') {
        return new Response(JSON.stringify(REMOTE_PAGE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/pages/1001') && method === 'PUT') {
        captured.putBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        const requested = captured.putBody as { version: { number: number } }
        return new Response(
          JSON.stringify({
            id: '1001',
            title: String(captured.putBody.title),
            version: { number: requested.version.number },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/child/attachment') && method === 'GET') {
        return new Response(JSON.stringify({ results: remoteAttachments }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/child/attachment') && method === 'POST') {
        captured.uploads.push(url)
        return new Response(JSON.stringify({ results: [{ id: 'att-new' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/rest/api/content/') && method === 'DELETE') {
        const id = url.split('/rest/api/content/')[1]!
        captured.deletedIds.push(id)
        return new Response(null, { status: 204 })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch,
  })
}

function writePage(root: string, relPath: string, title: string): void {
  mkdirSync(join(root, relPath.replace(/\/index\.md$/, '')), { recursive: true })
  writeFileSync(
    join(root, relPath),
    `---\npageId: "1001"\nspaceKey: "DEV"\ntitle: ${JSON.stringify(title)}\nversion: 2\nparentId: null\nurl: "https://acme.atlassian.net/wiki/spaces/DEV/pages/1001"\nupdatedAt: null\nsyncedAt: null\n---\n\n새 본문`,
    'utf8',
  )
}

function snapshotFor(root: string, relPath: string) {
  return {
    capturedAt: new Date().toISOString(),
    entries: new Map([[relPath, { hash: fileHashOf(readFileSync(join(root, relPath))) }]]),
  }
}

describe('push 동기화 정합', () => {
  it('로컬 제목을 우선해 업로드한다(원격 rename이 로컬 rename을 덮지 않는다)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'push-title-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const relPath = 'spaces/DEV/가이드/index.md'
    writePage(root, relPath, '로컬에서 바꾼 제목')
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    db.upsertPage({
      pageId: '1001',
      spaceKey: 'DEV',
      path: relPath,
      title: '로컬에서 바꾼 제목',
      version: 2,
      parentId: null,
      contentHash: 'old',
    })
    const captured: Captured = { deletedIds: [], uploads: [] }

    const outcome = await pushApprovedPages({
      client: makeClient(captured, []),
      workspaceRoot: root,
      db,
      machine: new SpaceStateMachine(),
      snapshot: snapshotFor(root, relPath),
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })

    expect(outcome.failed).toHaveLength(0)
    expect(captured.putBody?.title).toBe('로컬에서 바꾼 제목')
    db.close()
  })

  it('로컬 디렉터리 이동을 parentId 변경 요청으로 push하고 메타를 맞춘다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'push-move-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    // 페이지가 'spaces/DEV/부모/가이드'로 이동한 상태(db 기록은 옛 위치)
    const movedPath = 'spaces/DEV/부모/가이드/index.md'
    writePage(root, movedPath, '가이드')
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    db.upsertPage({
      pageId: '2000',
      spaceKey: 'DEV',
      path: 'spaces/DEV/부모/index.md',
      title: '부모',
      version: 1,
      parentId: null,
      contentHash: 'p',
    })
    db.upsertPage({
      pageId: '1001',
      spaceKey: 'DEV',
      path: 'spaces/DEV/가이드/index.md',
      title: '가이드',
      version: 2,
      parentId: null,
      contentHash: 'old',
    })
    const captured: Captured = { deletedIds: [], uploads: [] }

    const outcome = await pushApprovedPages({
      client: makeClient(captured, []),
      workspaceRoot: root,
      db,
      machine: new SpaceStateMachine(),
      snapshot: snapshotFor(root, movedPath),
      approvedPaths: [movedPath],
      spaceId: 'sp-1',
    })

    expect(outcome.failed).toHaveLength(0)
    expect(captured.putBody?.parentId).toBe('2000')
    expect(captured.putBody?.parentType).toBe('page')
    // push 후 파일·db의 parentId가 새 위치로 정합
    expect(readFileSync(join(root, movedPath), 'utf8')).toContain('parentId: "2000"')
    expect(db.getPage('1001')?.parentId).toBe('2000')
    db.close()
  })

  it('동기화 이력 있는 첨부만 원격 정리하고, 미동기 원격 첨부는 보존·보고한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'push-attach-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const relPath = 'spaces/DEV/가이드/index.md'
    writePage(root, relPath, '가이드')
    // 로컬 첨부는 keep.png 하나(관리 중) — old.png는 로컬에서 삭제된 상태(과거 동기화 이력 있음)
    mkdirSync(join(root, 'spaces/DEV/가이드/attachments'), { recursive: true })
    writeFileSync(join(root, 'spaces/DEV/가이드/attachments/keep.png'), 'KEEP')
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    db.upsertPage({
      pageId: '1001',
      spaceKey: 'DEV',
      path: relPath,
      title: '가이드',
      version: 2,
      parentId: null,
      contentHash: 'old',
    })
    db.upsertAttachment({
      pageId: '1001',
      fileName: 'keep.png',
      mediaType: 'image/png',
      fileHash: fileHashOf(Buffer.from('KEEP')),
    })
    // old.png는 과거에 동기화됐다가 로컬에서 삭제 — 원격 정리 대상
    db.upsertAttachment({
      pageId: '1001',
      fileName: 'old.png',
      mediaType: 'image/png',
      fileHash: 'previous-hash',
    })
    const captured: Captured = { deletedIds: [], uploads: [] }

    const outcome = await pushApprovedPages({
      client: makeClient(captured, [
        { id: 'att-keep', title: 'keep.png' },
        { id: 'att-old', title: 'old.png' },
        // unknown.png는 로컬로 한 번도 동기화된 적 없는 원격 첨부
        { id: 'att-unknown', title: 'unknown.png' },
      ]),
      workspaceRoot: root,
      db,
      machine: new SpaceStateMachine(),
      snapshot: snapshotFor(root, relPath),
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })

    expect(outcome.failed).toHaveLength(0)
    // keep.png는 해시 동일 → 재업로드 없음
    expect(captured.uploads).toHaveLength(0)
    // old.png(이력 있음·로컬 삭제)만 원격 삭제 + db 정리 + 보고
    expect(captured.deletedIds).toEqual(['att-old'])
    expect(outcome.deletedAttachments).toEqual([
      { path: 'spaces/DEV/가이드/attachments/old.png', fileName: 'old.png' },
    ])
    expect(db.listAttachmentsByPage('1001').some((record) => record.fileName === 'old.png')).toBe(
      false,
    )
    // unknown.png(이력 없음)는 삭제하지 않고 보존·보고한다
    expect(outcome.skippedRemoteAttachments).toEqual([
      { path: 'spaces/DEV/가이드/attachments/unknown.png', fileName: 'unknown.png' },
    ])
    expect(captured.deletedIds).not.toContain('att-unknown')
    expect(existsSync(join(root, 'spaces/DEV/가이드/attachments/keep.png'))).toBe(true)
    db.close()
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('업로드 루프 중 변경 재검증(P1 TOCTOU)', () => {
  it('루프 도중 파일이 바뀌면 해당 페이지를 failed로 보고하고 나머지를 중단한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'push-mid-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const relA = 'spaces/DEV/a/index.md'
    const relB = 'spaces/DEV/b/index.md'
    const pageFile = (pageId: string): string =>
      `---\npageId: "${pageId}"\nspaceKey: "DEV"\ntitle: "페이지${pageId}"\nversion: 2\nparentId: null\nurl: "https://acme.atlassian.net/wiki/spaces/DEV/pages/${pageId}"\nupdatedAt: null\nsyncedAt: null\n---\n\n본문 ${pageId}`
    mkdirSync(join(root, 'spaces/DEV/a'), { recursive: true })
    mkdirSync(join(root, 'spaces/DEV/b'), { recursive: true })
    writeFileSync(join(root, relA), pageFile('1001'), 'utf8')
    writeFileSync(join(root, relB), pageFile('1002'), 'utf8')
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    for (const [pageId, relPath] of [
      ['1001', relA],
      ['1002', relB],
    ] as const) {
      db.upsertPage({
        pageId,
        spaceKey: 'DEV',
        path: relPath,
        title: `페이지${pageId}`,
        version: 2,
        parentId: null,
        contentHash: 'old',
      })
    }
    const snapshot = {
      capturedAt: new Date().toISOString(),
      entries: new Map(
        [relA, relB].map((relPath) => [
          relPath,
          { hash: fileHashOf(readFileSync(join(root, relPath), 'utf8')) },
        ]),
      ),
    }
    let putB = false
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      sleep: () => Promise.resolve(),
      fetchImpl: (async (input: Request | string | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v2/pages/1001') && method === 'PUT') {
          // 첫 페이지 업로드 I/O 사이에 외부 편집기가 B를 수정
          writeFileSync(
            join(root, relB),
            `${readFileSync(join(root, relB), 'utf8')}\n<!-- 외부 편집 -->`,
            'utf8',
          )
          return jsonResponse({ id: '1001', title: '페이지1001', version: { number: 3 } })
        }
        if (url.includes('/api/v2/pages/1002') && method === 'PUT') {
          putB = true
          return jsonResponse({ id: '1002', title: '페이지1002', version: { number: 3 } })
        }
        const match = /\/api\/v2\/pages\/(\d+)/.exec(url)
        if (match) {
          return jsonResponse({
            id: match[1],
            title: `페이지${match[1]}`,
            version: { number: 2 },
            body: { storage: { value: '<p>원격</p>' } },
          })
        }
        if (url.includes('/child/attachment')) return jsonResponse({ results: [] })
        return jsonResponse({})
      }) as unknown as typeof fetch,
    })

    const outcome = await pushApprovedPages({
      client,
      workspaceRoot: root,
      db,
      machine: new SpaceStateMachine(),
      snapshot,
      approvedPaths: [relA, relB],
      spaceId: 'sp-1',
    })

    expect(outcome.uploaded.map((item) => item.path)).toEqual([relA])
    expect(outcome.failed).toEqual([
      { path: relB, error: '업로드 도중 파일이 변경되었습니다. 다시 검토(diff)하고 승인하세요.' },
    ])
    expect(putB).toBe(false)
    db.close()
  })
})
