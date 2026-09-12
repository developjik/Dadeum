import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncStateDb, PageRecord } from '../store/syncState'
import { fileHashOf } from '../store/hash'

/**
 * 페이지 id 대차(reconciliation — 계획 §8.1, F-3/F-4/F2):
 * 원격 목록에 없는 로컬 페이지 = 원격 삭제·이동.
 * - dirty 파일(hash 불일치)은 tombstone 하지 않고 충돌 후보로 남긴다(안전 우선)
 * - tombstone: 디렉터리를 .sync/trash/<ts>/로 이동(자동 삭제 없음) + remote_deleted 표시
 */
export interface ReconciliationResult {
  tombstoned: string[]
  conflictCandidates: string[]
}

export function reconcilePageIds(options: {
  spaceKey: string
  remotePageIds: string[]
  db: SyncStateDb
  workspaceRoot: string
  trashDir: string
  now: Date
}): ReconciliationResult {
  const { spaceKey, remotePageIds, db, workspaceRoot, trashDir, now } = options
  const remote = new Set(remotePageIds)
  const result: ReconciliationResult = { tombstoned: [], conflictCandidates: [] }

  const localPages: PageRecord[] = db.listPagesBySpace(spaceKey).filter((page) => !page.remoteDeleted)
  for (const page of localPages) {
    if (remote.has(page.pageId)) continue

    const absPath = join(workspaceRoot, page.path)
    const dirty = isDirty(page, absPath)
    if (dirty) {
      result.conflictCandidates.push(page.pageId)
      continue
    }

    const tombstoneDir = join(trashDir, String(now.getTime()))
    if (existsSync(absPath)) {
      const targetDir = join(tombstoneDir, page.path.replace(/\/index\.md$/, ''))
      mkdirSync(targetDir, { recursive: true })
      renameSync(absPath, join(targetDir, 'index.md'))
    }
    db.markRemoteDeleted(page.pageId)
    result.tombstoned.push(page.pageId)
  }

  return result
}

function isDirty(page: PageRecord, absPath: string): boolean {
  if (!existsSync(absPath)) return false
  const current = fileHashOf(readFileSync(absPath))
  return page.contentHash !== null && current !== page.contentHash
}
