import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfluenceClient, ConfluenceSpace } from '../../core/confluence/client'
import { pageHashMatches } from '../../core/store/pageFingerprint'
import type { SyncStateDb } from '../../core/store/syncState'
import { dirSafeSpaceKey, slugify } from '../../core/store/workspace'
import { machineFor } from './machines'
import { pullSinglePage } from './pullService'

/**
 * 증분 pull 1회(계획 §8.1): lastmodified 증분(CQL, 5분 overlap) → 변경 페이지만
 * 재변환·갱신 → dirty 파일 보호(해시 불일치는 건드리지 않고 충돌 후보로 남김).
 */

export interface IncrementalPullResult {
  updated: string[]
  skippedDirty: string[]
  failed: string[]
}
export async function pullIncremental(options: {
  client: ConfluenceClient
  space: ConfluenceSpace
  workspaceRoot: string
  db: SyncStateDb
  sinceIso: string
}): Promise<IncrementalPullResult> {
  const { client, space, workspaceRoot, db, sinceIso } = options
  const machine = machineFor(space.key)
  const started = machine.apply('startPull')
  if (!started.ok) return { updated: [], skippedDirty: [], failed: [] }
  if (started.note === 'pull-deferred') return { updated: [], skippedDirty: [], failed: [] } // agent-run/pushing 중 연기

  try {
    const changedIds = await client.listPageIdsModifiedSince(space.key, sinceIso)
    const updated: string[] = []
    const skippedDirty: string[] = []
    const failed: string[] = []

    for (const pageId of changedIds) {
      const record = db.getPage(pageId)
      if (record?.remoteDeleted) continue // 원격 삭제 수용 후 재생성은 사용자 안내 대상

      try {
        const detail = await client.getPageStorage(pageId)
        const dir = record
          ? record.path.replace(/\/index\.md$/, '')
          : `spaces/${dirSafeSpaceKey(space.key)}/${slugify(detail.title)}` // 원격 신규 페이지

        // dirty 보호: 로컬 hash가 last-synced와 다르면 건드리지 않는다
        const absPath = join(workspaceRoot, dir, 'index.md')
        if (record?.contentHash && existsSync(absPath)) {
          if (!pageHashMatches(readFileSync(absPath, 'utf8'), record.contentHash)) {
            skippedDirty.push(pageId)
            continue
          }
        }

        await pullSinglePage({
          client,
          space,
          workspaceRoot,
          db,
          summary: {
            id: detail.id,
            title: detail.title,
            version: detail.version,
            parentId: record?.parentId ?? null,
          },
          dir,
        })
        updated.push(pageId)
      } catch {
        // 페이지 단위 격리: 한 페이지 실패가 증분 전체를 중단시키지 않는다
        failed.push(pageId)
      }
    }

    return { updated, skippedDirty, failed }
  } finally {
    machine.apply('endPull')
  }
}
