import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { fileHashOf } from '../../core/store/hash'
import { SyncStateDb } from '../../core/store/syncState'
import { resolveConflict } from './conflictService'

const REMOTE_STORAGE = '<p>서버의 최신 본문</p>'

function makeClient(overrides?: { remoteStorage?: string }): ConfluenceClient {
  const initialStorage = overrides?.remoteStorage ?? REMOTE_STORAGE
  // 실제 서버처럼: PUT이 저장한 내용을 이후 GET(반영 검증)이 되돌려본다
  let storedStorage = initialStorage
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
            version: { number: 3 },
            body: { storage: { value: storedStorage } },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      if (url.includes('/api/v2/pages/1001') && method === 'PUT') {
        const requested = JSON.parse(String(init?.body)) as { body: { value: string } }
        storedStorage = requested.body.value
        return new Response(
          JSON.stringify({ id: '1001', title: '가이드', version: { number: 4 } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch,
  })
}

function setup(): { root: string; db: SyncStateDb; relPath: string; absPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'conflict-'))
  mkdirSync(join(root, '.sync'), { recursive: true })
  mkdirSync(join(root, 'spaces/DEV/가이드'), { recursive: true })
  const relPath = 'spaces/DEV/가이드/index.md'
  const absPath = join(root, relPath)
  writeFileSync(
    absPath,
    '---\npageId: "1001"\nspaceKey: "DEV"\ntitle: "가이드"\nversion: 2\nparentId: null\nurl: "https://acme.atlassian.net/wiki/spaces/DEV/pages/1001"\nupdatedAt: null\nsyncedAt: null\n---\n\n로컬에서 고친 본문',
  )
  const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
  db.upsertPage({
    pageId: '1001',
    spaceKey: 'DEV',
    path: relPath,
    title: '가이드',
    version: 2,
    parentId: null,
    contentHash: fileHashOf('원본과 다른 해시 — 로컬이 dirty'),
  })
  return { root, db, relPath, absPath }
}

describe('resolveConflict(ef-8 4지 선택)', () => {
  it('① 덮어쓰기: 최신 원격 버전 기준으로 업로드하고 버전 증가를 확인한다', async () => {
    const { root, db, relPath, absPath } = setup()
    const result = await resolveConflict({
      choice: 'overwrite',
      path: relPath,
      pageId: '1001',
      client: makeClient(),
      workspaceRoot: root,
      db,
    })
    expect(result.applied).toBe('overwrite')
    const raw = readFileSync(absPath, 'utf8')
    expect(raw).toContain('version: 4') // 원격 기준 3 → 4
    expect(raw).toContain('로컬에서 고친 본문') // 로컬 본문이 업로드된 판
    expect(db.getPage('1001')?.baseBody).toContain('로컬에서 고친 본문')
    expect(db.getPage('1001')?.baseVersion).toBe(4)
  })

  it('② 원격 받기: 로컬 변경을 trash로 백업하고 원격 판으로 교체한다', async () => {
    const { root, db, relPath, absPath } = setup()
    const result = await resolveConflict({
      choice: 'take-remote',
      path: relPath,
      pageId: '1001',
      client: makeClient(),
      workspaceRoot: root,
      db,
    })
    expect(result.applied).toBe('take-remote')
    expect(result.backupPath).toBeDefined()
    expect(existsSync(result.backupPath!)).toBe(true)
    expect(readFileSync(absPath, 'utf8')).toContain('서버의 최신 본문')
    expect(db.getPage('1001')?.baseBody).toContain('서버의 최신 본문')
    expect(db.getPage('1001')?.baseVersion).toBe(3)
  })

  it('③ 둘 다 보존: 원격 판을 .remote.md로 내려받고 로컬을 다음 업로드의 기준으로 남긴다', async () => {
    const { root, db, relPath, absPath } = setup()
    const result = await resolveConflict({
      choice: 'keep-both',
      path: relPath,
      pageId: '1001',
      client: makeClient(),
      workspaceRoot: root,
      db,
    })
    expect(result.applied).toBe('keep-both')
    // 원격 판 보존 산출물(allowlist 밖 — 변경 세트 유입 없음)
    expect(result.remoteFile).toBeDefined()
    expect(existsSync(result.remoteFile!)).toBe(true)
    expect(readFileSync(result.remoteFile!, 'utf8')).toContain('서버의 최신 본문')
    // 로컬 본문은 그대로, 기준 버전만 원격(3)으로 전진 — 다음 push는 충돌 없이 로컬이 이긴다
    const raw = readFileSync(absPath, 'utf8')
    expect(raw).toContain('로컬에서 고친 본문')
    expect(raw).toContain('version: 3')
    const page = db.getPage('1001')
    expect(page?.version).toBe(3)
    expect(page?.baseBody).toContain('서버의 최신 본문') // 3-way 병합의 base = 원격 분기
    expect(page?.baseVersion).toBe(3)
  })

  it('④ 직접 처리: 원격 본문을 .remote.md로 생성한다(allowlist 제외)', async () => {
    const { root, db, relPath } = setup()
    const result = await resolveConflict({
      choice: 'manual',
      path: relPath,
      pageId: '1001',
      client: makeClient(),
      workspaceRoot: root,
      db,
    })
    expect(result.applied).toBe('manual')
    expect(result.remoteFile).toBeDefined()
    expect(existsSync(result.remoteFile!)).toBe(true)
    expect(readFileSync(result.remoteFile!, 'utf8')).toContain('서버의 최신 본문')
  })
  it('빈 원격 본문(Live Doc 의심)은 원격 받기·둘 다 보존을 차단한다', async () => {
    const { root, db, relPath, absPath } = setup()
    const before = readFileSync(absPath, 'utf8')
    for (const choice of ['take-remote', 'keep-both'] as const) {
      await expect(
        resolveConflict({
          choice,
          path: relPath,
          pageId: '1001',
          client: makeClient({ remoteStorage: '' }),
          workspaceRoot: root,
          db,
        }),
      ).rejects.toThrow('비어')
    }
    // 로컬 파일은 어떤 분기에서도 건드리지 않는다
    expect(readFileSync(absPath, 'utf8')).toBe(before)
  })

  it('경로 탈출 시도는 게이트에서 거부된다(워크스페이스 밖 쓰기 차단 — SEC-002)', async () => {
    const { root, db } = setup()
    const client = makeClient()
    for (const malicious of [
      '../outside.md',
      'spaces/../../escape/index.md',
      '/tmp/evil/index.md',
    ]) {
      await expect(
        resolveConflict({
          choice: 'manual',
          path: malicious,
          pageId: '1001',
          client,
          workspaceRoot: root,
          db,
        }),
      ).rejects.toThrow('동기 대상이 아닌 경로')
    }
    expect(existsSync(join(root, '../outside.md'))).toBe(false)
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })
})
