import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SyncStateDb } from '../store/syncState'
import { captureSnapshot, verifySnapshot } from './approval'
import { computeChangeSet } from './changeSet'

function setupWorkspace(): { root: string; db: SyncStateDb } {
  const root = mkdtempSync(join(tmpdir(), 'push-cs-'))
  mkdirSync(join(root, '.sync'), { recursive: true })
  mkdirSync(join(root, 'spaces/DEV/가이드'), { recursive: true })
  writeFileSync(
    join(root, 'spaces/DEV/가이드/index.md'),
    '---\npageId: "1001"\nspaceKey: "DEV"\ntitle: "가이드"\nversion: 2\nparentId: null\nurl: "https://acme.atlassian.net/wiki/spaces/DEV/pages/1001"\nupdatedAt: null\nsyncedAt: null\n---\n\n본문',
  )
  const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
  db.upsertPage({
    pageId: '1001',
    spaceKey: 'DEV',
    path: 'spaces/DEV/가이드/index.md',
    title: '가이드',
    version: 2,
    parentId: null,
    contentHash: 'stale-hash', // 파일은 새로 쓰여졌으므로 dirty
  })
  return { root, db }
}

describe('computeChangeSet', () => {
  it('해시 불일치 페이지를 modified로 산출한다', () => {
    const { root, db } = setupWorkspace()
    const changes = computeChangeSet(root, db, 'DEV')
    expect(changes.modified).toHaveLength(1)
    expect(changes.modified[0]?.pageId).toBe('1001')
    expect(changes.modified[0]?.newHash).not.toBe('stale-hash')
  })

  it('db에 없는 신규 index.md를 added로 산출한다', () => {
    const { root, db } = setupWorkspace()
    mkdirSync(join(root, 'spaces/DEV/신규'), { recursive: true })
    writeFileSync(
      join(root, 'spaces/DEV/신규/index.md'),
      '---\npageId: null\nspaceKey: "DEV"\ntitle: "신규"\nversion: 0\nparentId: null\nurl: ""\nupdatedAt: null\nsyncedAt: null\n---\n\n새 문서',
    )
    const changes = computeChangeSet(root, db, 'DEV')
    expect(changes.added).toHaveLength(1)
    expect(changes.added[0]?.title).toBe('신규')
  })

  it('파일이 사라진 페이지를 missing으로 산출한다', () => {
    const { root, db } = setupWorkspace()
    db.upsertPage({
      pageId: '2002',
      spaceKey: 'DEV',
      path: 'spaces/DEV/사라진/index.md',
      title: '사라진',
      version: 1,
      parentId: null,
      contentHash: 'h',
    })
    const changes = computeChangeSet(root, db, 'DEV')
    expect(changes.missing.map((page) => page.pageId)).toContain('2002')
  })
  it('경로 조작 spaceKey를 거부한다(SEC-001)', () => {
    const { root, db } = setupWorkspace()
    for (const bad of ['../outside', 'a/b', '..']) {
      expect(() => computeChangeSet(root, db, bad)).toThrow('잘못된 스페이스 키')
    }
  })
})

describe('승인 스냅샷(TOCTOU 차단, F-2)', () => {
  it('승인 시점과 동일하면 ok, 바뀌면 mismatch를 보고한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'push-snap-'))
    const file = join(root, 'spaces/DEV/가이드/index.md')
    mkdirSync(join(root, 'spaces/DEV/가이드'), { recursive: true })
    writeFileSync(file, '승인 시점 내용')

    const snapshot = captureSnapshot(root, ['spaces/DEV/가이드/index.md'])
    expect(verifySnapshot(root, snapshot).ok).toBe(true)

    writeFileSync(file, '승인 후 바뀐 내용')
    const result = verifySnapshot(root, snapshot)
    expect(result.ok).toBe(false)
    expect(result.mismatched).toEqual(['spaces/DEV/가이드/index.md'])
  })
})
