import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ConfluenceClient } from '../../core/confluence/client'
import type { ApprovalSnapshot } from '../../core/push/approval'
import type { PushOutcome } from '../../core/push/types'
import { fileHashOf } from '../../core/store/hash'
import type { SyncStateDb } from '../../core/store/syncState'
import { parsePageFile } from '../../core/store/workspace'
import type { SpaceStateMachine } from '../../core/sync/spaceStateMachine'
import { pushApprovedPages } from './pushService'

/**
 * 승인 경로를 페이지 경로와 첨부 경로로 분리해 처리한다(ef-9 — 첨부-only 승인 지원).
 * 페이지는 pushApprovedPages(위상 정렬·버전 게이트·TOCTOU)로, 첨부는
 * 페이지 push 완료 후 소유 페이지 pageId 기준으로 업로드한다.
 */
function splitApprovedPaths(allPaths: string[]): {
  pagePaths: string[]
  attachmentPaths: string[]
} {
  const pagePaths = allPaths.filter((p) => p.endsWith('index.md'))
  const attachmentPaths = allPaths.filter(
    (p) => !p.endsWith('index.md') && p.includes('/attachments/'),
  )
  return { pagePaths, attachmentPaths }
}

/** 첨부 경로의 소유 페이지 경로(.../attachments/<file> → 동일 디렉터리 index.md). */
function ownerIndexPath(attachmentPath: string): string {
  return attachmentPath.replace(/attachments\/[^/]+$/, 'index.md')
}

export async function pushApproved(options: {
  client: ConfluenceClient
  workspaceRoot: string
  db: SyncStateDb
  machine: SpaceStateMachine
  snapshot: ApprovalSnapshot
  approvedPaths: string[]
  spaceId: string
}): Promise<PushOutcome> {
  const { client, workspaceRoot, db, machine, snapshot, approvedPaths, spaceId } = options
  const { pagePaths, attachmentPaths } = splitApprovedPaths(approvedPaths)

  // 1. 페이지 push(기존 검증된 파이프라인 위임 — TOCTOU·버전 게이트 포함)
  const outcome = await pushApprovedPages({
    client,
    workspaceRoot,
    db,
    machine,
    snapshot,
    approvedPaths: pagePaths,
    spaceId,
  })

  // 2. 첨부 업로드 — 상태머신 push 락 '내부'에서 실행한다(에이전트 동시 편집·이중 push 차단)
  const startedAttachments = machine.apply('startPush')
  if (!startedAttachments.ok) {
    for (const attPath of attachmentPaths) {
      outcome.failed.push({
        path: attPath,
        error: '동기화 또는 에이전트 실행 중이라 첨부를 업로드할 수 없습니다',
      })
    }
    return outcome
  }
  try {
    for (const attPath of attachmentPaths) {
      try {
        const ownerIndex = ownerIndexPath(attPath)
        const ownerAbs = join(workspaceRoot, ownerIndex)
        if (!existsSync(ownerAbs)) {
          outcome.failed.push({ path: attPath, error: '소유 페이지 index.md를 찾을 수 없습니다' })
          continue
        }
        const pageId = parsePageFile(readFileSync(ownerAbs, 'utf8')).meta.pageId
        const content = readFileSync(join(workspaceRoot, attPath))
        // F-2 재검증: 스냅샷 해시와 현재 바이트 대조(페이지 파이프라인과 동일 기준)
        const snapEntry = snapshot.entries.get(attPath)
        if (snapEntry && snapEntry.hash !== fileHashOf(content)) {
          outcome.failed.push({
            path: attPath,
            error: '승인 후 첨부가 변경되었습니다. 다시 검토하고 승인하세요.',
          })
          continue
        }
        await client.uploadAttachment(
          pageId,
          basename(attPath),
          content,
          'application/octet-stream',
        )
        db.upsertAttachment({
          pageId,
          fileName: basename(attPath),
          mediaType: 'application/octet-stream',
          fileHash: fileHashOf(content),
        })
        outcome.uploaded.push({ path: attPath, pageId, newVersion: -1 })
      } catch (cause) {
        outcome.failed.push({
          path: attPath,
          error: String(cause instanceof Error ? cause.message : cause),
        })
      }
    }
  } finally {
    machine.apply('endPush')
  }

  return outcome
}
