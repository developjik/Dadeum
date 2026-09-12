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
      updatedAt: '2026-09-12T00:00:00.000Z'
    })

    const page = db.getPage('9007199254740991')
    expect(page?.version).toBe(3)
    expect(page?.remoteDeleted).toBe(false)
    expect(db.getPageByPath('spaces/DEV/가이드/index.md')?.pageId).toBe('9007199254740991')
  })

  it('같은 pageId 재삽입은 갱신으로 처리한다', () => {
    const db = freshDb()
    db.upsertPage({ pageId: '1', spaceKey: 'DEV', path: 'p/index.md', title: 't', version: 1, contentHash: null, updatedAt: null })
    db.upsertPage({ pageId: '1', spaceKey: 'DEV', path: 'p/index.md', title: 't', version: 2, contentHash: 'h', updatedAt: null })

    expect(db.getPage('1')?.version).toBe(2)
    expect(db.listPagesBySpace('DEV')).toHaveLength(1)
  })

  it('원격 삭제 표시를 토글한다', () => {
    const db = freshDb()
    db.upsertPage({ pageId: '5', spaceKey: 'DEV', path: 'p/index.md', title: 't', version: 1, contentHash: null, updatedAt: null })
    db.markRemoteDeleted('5')
    expect(db.getPage('5')?.remoteDeleted).toBe(true)
    db.clearRemoteDeleted('5')
    expect(db.getPage('5')?.remoteDeleted).toBe(false)
  })

  it('첨부 메타를 페이지별로 관리한다', () => {
    const db = freshDb()
    db.upsertAttachment({ pageId: '5', fileName: 'logo.png', mediaType: 'image/png', fileHash: 'f1' })
    db.upsertAttachment({ pageId: '5', fileName: 'logo.png', mediaType: 'image/png', fileHash: 'f2' })

    const list = db.listAttachmentsByPage('5')
    expect(list).toHaveLength(1)
    expect(list[0]?.fileHash).toBe('f2')
  })

  it('pending-create 저널은 기록→확정 흐름을 가진다', () => {
    const db = freshDb()
    const journalId = db.recordPendingCreate('DEV', null, 'spaces/DEV/새페이지/index.md', '새페이지')
    expect(db.listUnconfirmedCreates()).toHaveLength(1)

    db.confirmPendingCreate(journalId, '777')
    expect(db.listUnconfirmedCreates()).toHaveLength(0)
    expect(db.getPage('777')).toBeNull() // 확정은 페이지 레코드와 별개
  })

  it('2^53 초과 pageId도 문자열로 무손실 보관한다', () => {
    const db = freshDb()
    const bigId = '9007199254740993'
    db.upsertPage({ pageId: bigId, spaceKey: 'DEV', path: 'big/index.md', title: 'b', version: 1, contentHash: null, updatedAt: null })
    expect(db.getPage(bigId)?.pageId).toBe(bigId)
  })
})
