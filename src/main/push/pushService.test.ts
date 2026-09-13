import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { SyncStateDb } from '../../core/store/syncState'
import { SpaceStateMachine } from '../../core/sync/spaceStateMachine'
import { pushApprovedPages } from './pushService'

const PAGE = {
  id: '1001',
  title: '가이드',
  version: { number: 2 },
  body: { storage: { value: '<p>서버 원본</p>' } },
}

function makeClient(overrides?: {
  updateVersion?: number
  failUpdate?: number
  remoteAttachments?: Array<{ id: string; fileName: string }>
  /** PUT은 성공하지만 재GET이 옛 내용을 돌려주는 침묵 no-op 시뮬레이션 */
  silentNoop?: boolean
}): ConfluenceClient {
  const updateVersion = overrides?.updateVersion
  const failUpdate = overrides?.failUpdate
  const remoteAttachments = overrides?.remoteAttachments ?? []
  const silentNoop = overrides?.silentNoop ?? false
  // 실제 서버처럼: PUT이 저장한 내용·버전을 이후 GET(반영 검증)이 되돌려본다
  let storedStorage = PAGE.body.storage.value
  let storedVersion = updateVersion ?? PAGE.version.number
  return new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    email: 'dev@acme.io',
    apiToken: 'tok',
    sleep: () => Promise.resolve(),
    fetchImpl: (async (input: Request | string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/api/v2/pages/1001') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: '1001',
            title: '가이드',
            version: { number: storedVersion },
            body: { storage: { value: storedStorage } },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      if (url.includes('/api/v2/pages/1001') && method === 'PUT') {
        if (failUpdate === 500) return new Response('server boom', { status: 500 })
        if (failUpdate === 409) return new Response('conflict', { status: 409 })
        const requested = JSON.parse(String(init?.body)) as {
          version: { number: number }
          body: { value: string }
        }
        storedVersion = requested.version.number
        if (!silentNoop) storedStorage = requested.body.value
        return new Response(
          JSON.stringify({
            id: '1001',
            title: '가이드',
            version: { number: requested.version.number },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/rest/api/content/1001/child/attachment') && method === 'GET') {
        return new Response(
          JSON.stringify({
            results: remoteAttachments.map((item) => ({
              id: item.id,
              title: item.fileName,
              metadata: { mediaType: { name: 'application/octet-stream' } },
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch,
  })
}

function setup(): { root: string; db: SyncStateDb; machine: SpaceStateMachine; relPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'push-svc-'))
  mkdirSync(join(root, '.sync'), { recursive: true })
  mkdirSync(join(root, 'spaces/DEV/가이드'), { recursive: true })
  const relPath = 'spaces/DEV/가이드/index.md'
  writeFileSync(
    join(root, relPath),
    '---\npageId: "1001"\nspaceKey: "DEV"\ntitle: "가이드"\nversion: 2\nparentId: null\nurl: "https://acme.atlassian.net/wiki/spaces/DEV/pages/1001"\nupdatedAt: null\nsyncedAt: null\n---\n\n새 본문',
  )
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
  const machine = new SpaceStateMachine()
  return { root, db, machine, relPath }
}

describe('pushApprovedPages', () => {
  it('승인된 페이지를 업로드하고 버전 증가를 확인한다(AC-3/AC-4)', async () => {
    const { root, db, machine, relPath } = setup()
    const snapshot = {
      capturedAt: new Date().toISOString(),
      entries: new Map([[relPath, { hash: await hashOf(join(root, relPath)) }]]),
    }

    const outcome = await pushApprovedPages({
      client: makeClient(),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })

    expect(outcome.failed).toHaveLength(0)
    expect(outcome.uploaded).toEqual([{ path: relPath, pageId: '1001', newVersion: 3 }])

    // 파일 frontmatter 갱신 확인
    const raw = readFileSync(join(root, relPath), 'utf8')
    expect(raw).toContain('version: 3')
  })

  it('승인 후 파일이 바뀌면 TOCTOU 차단으로 업로드하지 않는다(F-2)', async () => {
    const { root, db, machine, relPath } = setup()
    const snapshot = {
      capturedAt: new Date().toISOString(),
      entries: new Map([[relPath, { hash: 'stale' }]]),
    }

    const outcome = await pushApprovedPages({
      client: makeClient(),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })

    expect(outcome.uploaded).toHaveLength(0)
    expect(outcome.failed[0]?.error).toContain('다시 검토')
  })

  it('원격 버전이 다르면 충돌로 분기하고 업로드하지 않는다(ef-3)', async () => {
    const { root, db, machine, relPath } = setup()
    const snapshot = freshSnapshot(join(root, relPath))
    const outcome = await pushApprovedPages({
      client: makeClient({ updateVersion: 9 }),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })
    expect(outcome.conflicts).toEqual([{ path: relPath, pageId: '1001', remoteVersion: 9 }])
    expect(outcome.uploaded).toHaveLength(0)
  })

  it('agent run 중에는 push가 차단된다(F-2 상태머신)', async () => {
    const { root, db, machine, relPath } = setup()
    machine.apply('startAgentRun')
    const snapshot = freshSnapshot(join(root, relPath))
    const outcome = await pushApprovedPages({
      client: makeClient(),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })
    expect(outcome.failed[0]?.error).toContain('push할 수 없습니다')
    expect(outcome.uploaded).toHaveLength(0)
  })

  it('PUT 409(사전 검사와 PUT 사이 원격 변경)는 충돌로 분류한다', async () => {
    const { root, db, machine, relPath } = setup()
    const snapshot = freshSnapshot(join(root, relPath))
    const outcome = await pushApprovedPages({
      // GET은 version 2로 응답(사전 검사 통과)하지만 PUT은 409 — TOCTOU 창 재현
      client: makeClient({ failUpdate: 409 }),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })
    expect(outcome.uploaded).toHaveLength(0)
    expect(outcome.conflicts).toEqual([{ path: relPath, pageId: '1001', remoteVersion: 2 }])
  })

  it('PUT은 성공했지만 서버에 다른 내용이 저장되면 반영 검증 실패로 보고한다(침묵 no-op 방지)', async () => {
    const { root, db, machine, relPath } = setup()
    const snapshot = freshSnapshot(join(root, relPath))
    const outcome = await pushApprovedPages({
      client: makeClient({ silentNoop: true }),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })
    expect(outcome.uploaded).toHaveLength(0)
    expect(outcome.failed[0]?.error).toContain('반영 검증 실패')
    // 파일·db가 옛 상태로 남아 다음 검토에서 다시 잡힌다
    expect(readFileSync(join(root, relPath), 'utf8')).toContain('version: 2')
  })

  it('첨부 디렉터리째 삭제하면 동기화된 원격 첨부를 삭제한다', async () => {
    const { root, db, machine, relPath } = setup()
    // 과거에 pull로 동기화된 첨부 기록 + 로컬에는 attachments/ 디렉터리 자체가 없음
    db.upsertAttachment({
      pageId: '1001',
      fileName: 'diagram.png',
      mediaType: 'application/octet-stream',
      fileHash: 'deadbeef',
    })
    const snapshot = freshSnapshot(join(root, relPath))
    const outcome = await pushApprovedPages({
      client: makeClient({ remoteAttachments: [{ id: 'att-7', fileName: 'diagram.png' }] }),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })
    expect(outcome.deletedAttachments).toEqual([
      { path: relPath.replace('index.md', 'attachments/diagram.png'), fileName: 'diagram.png' },
    ])
    expect(db.listAttachmentsByPage('1001')).toHaveLength(0)
  })

  it('한 번도 동기화된 적 없는 원격 첨부는 디렉터리가 없어도 보존·보고한다', async () => {
    const { root, db, machine, relPath } = setup()
    const snapshot = freshSnapshot(join(root, relPath))
    const outcome = await pushApprovedPages({
      client: makeClient({ remoteAttachments: [{ id: 'att-9', fileName: 'unknown.bin' }] }),
      workspaceRoot: root,
      db,
      machine,
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1',
    })
    expect(outcome.deletedAttachments).toHaveLength(0)
    expect(outcome.skippedRemoteAttachments).toEqual([
      { path: relPath.replace('index.md', 'attachments/unknown.bin'), fileName: 'unknown.bin' },
    ])
  })
})

function freshSnapshot(absPath: string): {
  capturedAt: string
  entries: Map<string, { hash: string }>
} {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hash = createHash('sha256').update(readFileSync(absPath)).digest('hex')
  return {
    capturedAt: new Date().toISOString(),
    entries: new Map([['spaces/DEV/가이드/index.md', { hash }]]),
  }
}

async function hashOf(absPath: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}
