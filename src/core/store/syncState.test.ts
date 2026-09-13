import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { SyncStateDb } from './syncState'

vi.mock('better-sqlite3', async () => {
  const mod = await import('better-sqlite3')
  return { default: mod.default }
})

function freshDb(): SyncStateDb {
  return new SyncStateDb(':memory:')
}

describe('SyncStateDb', () => {
  it('페이지를 upsert하고 조회한다', () => {
    const db = freshDb()
    db.upsertPage({
      pageId: '9007199254740991',
      spaceKey: 'DEV',
      path: 'spaces/DEV/가이드/index.md',
      title: '가이드',
      version: 3,
      contentHash: 'abc123',
      updatedAt: '2026-09-12T00:00:00.000Z',
    })

    const page = db.getPage('9007199254740991')
    expect(page?.version).toBe(3)
    expect(page?.remoteDeleted).toBe(false)
    expect(db.getPageByPath('spaces/DEV/가이드/index.md')?.pageId).toBe('9007199254740991')
  })

  it('같은 pageId 재삽입은 갱신으로 처리한다', () => {
    const db = freshDb()
    db.upsertPage({
      pageId: '1',
      spaceKey: 'DEV',
      path: 'p/index.md',
      title: 't',
      version: 1,
      contentHash: null,
      updatedAt: null,
    })
    db.upsertPage({
      pageId: '1',
      spaceKey: 'DEV',
      path: 'p/index.md',
      title: 't',
      version: 2,
      contentHash: 'h',
      updatedAt: null,
    })

    expect(db.getPage('1')?.version).toBe(2)
    expect(db.listPagesBySpace('DEV')).toHaveLength(1)
  })

  it('원격 삭제 표시를 토글한다', () => {
    const db = freshDb()
    db.upsertPage({
      pageId: '5',
      spaceKey: 'DEV',
      path: 'p/index.md',
      title: 't',
      version: 1,
      contentHash: null,
      updatedAt: null,
    })
    db.markRemoteDeleted('5')
    expect(db.getPage('5')?.remoteDeleted).toBe(true)
    db.clearRemoteDeleted('5')
    expect(db.getPage('5')?.remoteDeleted).toBe(false)
  })

  it('첨부 메타를 페이지별로 관리한다', () => {
    const db = freshDb()
    db.upsertAttachment({
      pageId: '5',
      fileName: 'logo.png',
      mediaType: 'image/png',
      fileHash: 'f1',
    })
    db.upsertAttachment({
      pageId: '5',
      fileName: 'logo.png',
      mediaType: 'image/png',
      fileHash: 'f2',
    })

    const list = db.listAttachmentsByPage('5')
    expect(list).toHaveLength(1)
    expect(list[0]?.fileHash).toBe('f2')
  })

  it('2^53 초과 pageId도 문자열로 무손실 보관한다', () => {
    const db = freshDb()
    const bigId = '9007199254740993'
    db.upsertPage({
      pageId: bigId,
      spaceKey: 'DEV',
      path: 'big/index.md',
      title: 'b',
      version: 1,
      contentHash: null,
      updatedAt: null,
    })
    expect(db.getPage(bigId)?.pageId).toBe(bigId)
  })

  it('스페이스별 에이전트 어댑터 선택을 저장·갱신한다', () => {
    const db = freshDb()
    expect(db.getAgentAdapterName('DEV')).toBeNull()
    db.setAgentAdapterName('DEV', 'pi')
    expect(db.getAgentAdapterName('DEV')).toBe('pi')
    // 다른 스페이스는 독립이다
    expect(db.getAgentAdapterName('OPS')).toBeNull()
    db.setAgentAdapterName('DEV', 'claude-code')
    expect(db.getAgentAdapterName('DEV')).toBe('claude-code')
  })

  it('채팅 세션 id를 스페이스에 1:1로 보관한다', () => {
    const db = freshDb()
    expect(db.getAgentSessionId('DEV')).toBeNull()
    db.setAgentSessionId('DEV', 'sess-1')
    db.setAgentSessionId('DEV', 'sess-2')
    expect(db.getAgentSessionId('DEV')).toBe('sess-2')
  })

  it('베이스 카피(마지막 동기화 기준본)를 페이지별로 보관한다', () => {
    const db = freshDb()
    db.upsertPage({
      pageId: '7',
      spaceKey: 'DEV',
      path: 'p/index.md',
      title: 't',
      version: 1,
      contentHash: null,
      updatedAt: null,
    })
    expect(db.getPage('7')?.baseBody).toBeNull()
    expect(db.getPage('7')?.baseVersion).toBeNull()

    db.setBaseCopy('7', '기준 본문\n', 4)
    expect(db.getPage('7')?.baseBody).toBe('기준 본문\n')
    expect(db.getPage('7')?.baseVersion).toBe(4)

    // upsert는 base를 덮어쓰지 않는다 — pull·push 완료 시점(setBaseCopy)에만 갱신된다
    db.upsertPage({
      pageId: '7',
      spaceKey: 'DEV',
      path: 'p/index.md',
      title: 't2',
      version: 5,
      contentHash: 'h2',
      updatedAt: null,
    })
    expect(db.getPage('7')?.baseBody).toBe('기준 본문\n')
    expect(db.getPage('7')?.title).toBe('t2')
  })

  it('v2 db(베이스 카피 컬럼 없음)를 v3로 마이그레이션한다', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sync-mig-')), 'state.db')
    const legacy = new BetterSqlite3(dbPath)
    legacy.exec(`CREATE TABLE pages (
      page_id TEXT PRIMARY KEY,
      space_key TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      version INTEGER NOT NULL,
      parent_id TEXT,
      content_hash TEXT,
      updated_at TEXT,
      synced_at TEXT NOT NULL,
      remote_deleted INTEGER NOT NULL DEFAULT 0
    );`)
    legacy.pragma('user_version = 2')
    legacy
      .prepare(
        `INSERT INTO pages (page_id, space_key, path, title, version, synced_at) VALUES ('1', 'DEV', 'p/index.md', 't', 2, '2026-01-01')`,
      )
      .run()
    legacy.close()

    const db = new SyncStateDb(dbPath)
    expect(db.getPage('1')?.title).toBe('t')
    expect(db.getPage('1')?.baseBody).toBeNull()
    db.setBaseCopy('1', '기준\n', 2)
    expect(db.getPage('1')?.baseBody).toBe('기준\n')
    expect(db.getPage('1')?.baseVersion).toBe(2)
    db.close()
  })
})
