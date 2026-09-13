import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fileHashOf } from '../store/hash'
import { SyncStateDb } from '../store/syncState'
import { computeNextDelay, PollScheduler } from './pollScheduler'
import { reconcilePageIds } from './reconciler'

function setup(): { root: string; db: SyncStateDb; trashDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-'))
  mkdirSync(join(root, '.sync'), { recursive: true })
  const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
  return { root, db, trashDir: join(root, '.sync', 'trash') }
}

function seedPage(
  root: string,
  db: SyncStateDb,
  pageId: string,
  dirName: string,
  body: string,
): string {
  const dir = join(root, 'spaces/DEV', dirName)
  mkdirSync(dir, { recursive: true })
  const relPath = `spaces/DEV/${dirName}/index.md`
  writeFileSync(join(dir, 'index.md'), body)
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  db.upsertPage({
    pageId,
    spaceKey: 'DEV',
    path: relPath,
    title: dirName,
    version: 1,
    parentId: null,
    contentHash: fileHashOf(readFileSync(join(dir, 'index.md'))),
  })
  void createHash
  return relPath
}

describe('reconcilePageIds(id 대차)', () => {
  it('원격에 없는 페이지를 tombstone 이동하고 remote_deleted로 표시한다', () => {
    const { root, db, trashDir } = setup()
    const relPath = seedPage(root, db, '1001', '삭제될-페이지', '내용')

    const result = reconcilePageIds({
      spaceKey: 'DEV',
      remotePageIds: ['2002'],
      db,
      workspaceRoot: root,
      trashDir,
      now: new Date(0),
    })

    expect(result.tombstoned).toEqual(['1001'])
    expect(existsSync(join(root, relPath))).toBe(false)
    expect(existsSync(join(trashDir, '0', 'spaces/DEV/삭제될-페이지/index.md'))).toBe(true)
    expect(db.getPage('1001')?.remoteDeleted).toBe(true)
  })

  it('dirty 파일은 tombstone 하지 않고 충돌 후보로 남긴다(안전 우선)', () => {
    const { root, db, trashDir } = setup()
    seedPage(root, db, '1001', '편집중', '원본')
    writeFileSync(join(root, 'spaces/DEV/편집중/index.md'), '에이전트가 고친 중') // hash 불일치

    const result = reconcilePageIds({
      spaceKey: 'DEV',
      remotePageIds: [],
      db,
      workspaceRoot: root,
      trashDir,
      now: new Date(0),
    })

    expect(result.tombstoned).toEqual([])
    expect(result.conflictCandidates).toEqual(['1001'])
    expect(db.getPage('1001')?.remoteDeleted).toBe(false)
  })

  it('원격에 존재하는 페이지는 건드리지 않는다', () => {
    const { root, db, trashDir } = setup()
    seedPage(root, db, '1001', '유지', '내용')
    const result = reconcilePageIds({
      spaceKey: 'DEV',
      remotePageIds: ['1001'],
      db,
      workspaceRoot: root,
      trashDir,
      now: new Date(0),
    })
    expect(result.tombstoned).toEqual([])
    expect(existsSync(join(root, 'spaces/DEV/유지/index.md'))).toBe(true)
  })
})

describe('computeNextDelay / PollScheduler', () => {
  it('지터 범위 안에서 지연을 계산한다', () => {
    const base = 300000
    expect(computeNextDelay(base, 0.1, 0)).toBe(base * 0.9)
    expect(computeNextDelay(base, 0.1, 1)).toBe(base * 1.1)
    expect(computeNextDelay(base, 0.1, 0.5)).toBe(base)
  })

  it('shouldSkip이 true면 폴링을 건너뛰지만 스케줄은 유지된다', async () => {
    vi.useFakeTimers()
    const onPoll = vi.fn(async () => undefined)
    const scheduler = new PollScheduler({
      baseIntervalMs: 100,
      jitterRatio: 0,
      onPoll,
      timer: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
      },
      random: () => 0.5,
      shouldSkip: () => true,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(150)
    expect(onPoll).not.toHaveBeenCalled()
    scheduler.stop()
    vi.useRealTimers()
  })

  it('주기마다 onPoll을 실행한다', async () => {
    vi.useFakeTimers()
    const onPoll = vi.fn(async () => undefined)
    const scheduler = new PollScheduler({
      baseIntervalMs: 100,
      jitterRatio: 0,
      onPoll,
      timer: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
      },
      random: () => 0.5,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(350)
    expect(onPoll.mock.calls.length).toBeGreaterThanOrEqual(3)
    scheduler.stop()
    vi.useRealTimers()
  })
})
