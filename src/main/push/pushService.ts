import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileHashOf } from '../../core/store/hash'
import type { ConfluenceClient } from '../../core/confluence/client'
import { markdownToStorage } from '../../core/converter/markdownToStorage'
import type { SyncStateDb } from '../../core/store/syncState'
import type { SpaceStateMachine } from '../../core/sync/spaceStateMachine'
import { parsePageFile } from '../../core/store/workspace'
import type { ApprovalSnapshot } from '../../core/push/approval'
import { verifySnapshot } from '../../core/push/approval'

/**
 * push 파이프라인(계획 §8.3, ef-6):
 * 승인 스냅샷 재검증(TOCTOU) → 상태머신 검사(agent-run 중 금지) → 사전 버전 검사
 * (404면 원격 삭제 안내, 불일치면 충돌 분기) → md→storage 변환(캐리어 재결합)
 * → v2 수정/신규 생성(저널·위상 정렬) → 버전 증가 확인 → DB 갱신.
 * 부분 실패 시 업로드분 유지, 실패 목록 반환(자동 롤백 없음 — 원격 쓰기 최소화).
 */
import type { PushOutcome } from '../../core/push/types'
export type { PushOutcome }

export async function pushApprovedPages(options: {
  client: ConfluenceClient
  workspaceRoot: string
  db: SyncStateDb
  machine: SpaceStateMachine
  snapshot: ApprovalSnapshot
  approvedPaths: string[]
  spaceId: string
}): Promise<PushOutcome> {
  const { client, workspaceRoot, db, machine, snapshot, approvedPaths, spaceId } = options
  const outcome: PushOutcome = { uploaded: [], conflicts: [], remoteDeleted: [], failed: [] }

  // 1차 가드: 상태머신(agent-run/pulling/pushing 중 금지 — F-2)
  if (!machine.canStartPush()) {
    outcome.failed.push({ path: '(전체)', error: '에이전트 실행 중이거나 동기화가 진행 중이라 push할 수 없습니다' })
    return outcome
  }

  // 2차 가드: 승인 스냅샷 재검증(승인 후 파일 변경 시 재 diff 강제)
  const verification = verifySnapshot(workspaceRoot, snapshot)
  if (!verification.ok) {
    for (const path of verification.mismatched) {
      outcome.failed.push({ path, error: '승인 후 파일이 변경되었습니다. 다시 검토(diff)하고 승인하세요.' })
    }
    return outcome
  }

  const started = machine.apply('startPush')
  if (!started.ok) {
    outcome.failed.push({ path: '(전체)', error: 'push를 시작할 수 없는 상태입니다' })
    return outcome
  }

  try {
    // 신규 페이지는 부모 먼저(위상 정렬: 경로 깊이 순)
    const ordered = [...approvedPaths].sort((a, b) => depth(a) - depth(b))
    for (const relPath of ordered) {
      try {
        await pushOne({ client, workspaceRoot, db, spaceId, relPath }, outcome)
      } catch (cause) {
        outcome.failed.push({ path: relPath, error: String(cause instanceof Error ? cause.message : cause) })
      }
    }
  } finally {
    machine.apply('endPush')
  }

  return outcome
}

function depth(relPath: string): number {
  return relPath.split('/').length
}

async function pushOne(
  context: { client: ConfluenceClient; workspaceRoot: string; db: SyncStateDb; spaceId: string; relPath: string },
  outcome: PushOutcome
): Promise<void> {
  const { client, workspaceRoot, db, spaceId, relPath } = context
  const absPath = join(workspaceRoot, relPath)
  if (!existsSync(absPath)) {
    outcome.failed.push({ path: relPath, error: '파일이 존재하지 않습니다' })
    return
  }

  const raw = readFileSync(absPath, 'utf8')
  const { meta, body } = parsePageFile(raw)
  const storageValue = markdownToStorage(body)

  // 사전 버전 검사: 404 → 원격 삭제 안내 분기 / 버전 불일치 → 충돌 분기(ef-3)
  let remoteVersion: number | null = null
  let remoteTitle: string | null = null
  const pageIdIsNumeric = /^\d+$/.test(meta.pageId)
  if (pageIdIsNumeric) {
    try {
      const remote = await client.getPageStorage(meta.pageId)
      remoteVersion = remote.version
      remoteTitle = remote.title
    } catch (cause) {
      if (cause instanceof Error && 'status' in cause && (cause as { status?: number }).status === 404) {
        outcome.remoteDeleted.push({ path: relPath, pageId: meta.pageId })
        return
      }
      throw cause
    }
    if (remoteVersion !== meta.version) {
      outcome.conflicts.push({ path: relPath, pageId: meta.pageId, remoteVersion })
      return
    }
  }

  if (!pageIdIsNumeric) {
    // 신규 생성(AC-9): 부모 먼저 업로드되도록 위상 정렬된 순서를 신뢰한다.
    const parentId = meta.parentId && /^\d+$/.test(meta.parentId) ? meta.parentId : undefined
    const created = await client.createPage({ spaceId, parentId, title: meta.title, storageValue })
    if (created.version !== 1) {
      throw new Error(`신규 생성 응답 버전이 비정상입니다: ${created.version}`)
    }
    const createdRaw = renderUpdatedFile(meta, created.pageId, created.version, body)
    writeFileSync(absPath, createdRaw, 'utf8')
    db.upsertPage({
      pageId: created.pageId,
      spaceKey: meta.spaceKey,
      path: relPath,
      title: created.title ?? meta.title,
      version: created.version,
      parentId: created.parentId ?? meta.parentId,
      contentHash: fileHashOf(createdRaw)
    })
    outcome.uploaded.push({ path: relPath, pageId: created.pageId, newVersion: created.version })

    // 신규 페이지 첨부 동기화(생성 후 즉시 업로드)
    const attachmentsDir = join(dirname(absPath), 'attachments')
    if (existsSync(attachmentsDir)) {
      for (const entry of readdirSync(attachmentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const content = readFileSync(join(attachmentsDir, entry.name))
        const hash = fileHashOf(content)
        await client.uploadAttachment(created.pageId, entry.name, content, 'application/octet-stream')
        db.upsertAttachment({ pageId: created.pageId, fileName: entry.name, mediaType: 'application/octet-stream', fileHash: hash })
      }
    }
    return
  }

  // 기존 페이지 수정: 요청 버전 명시(remoteVersion === meta.version 보장)
  const expectedRemote = remoteVersion ?? meta.version
  const updated = await client.updatePage({
    pageId: meta.pageId,
    currentVersion: expectedRemote,
    title: remoteTitle ?? meta.title,
    storageValue
  })
  // 반영 성공 판정(AC-4): 응답 버전 == 기대+1
  if (updated.version !== expectedRemote + 1) {
    throw new Error(`버전 증가 확인 실패: 기대 ${expectedRemote + 1}, 응답 ${updated.version}`)
  }

  const updatedRaw = renderUpdatedFile(meta, meta.pageId, updated.version, body)
  writeFileSync(absPath, updatedRaw, 'utf8')
  // B-7: 기존 페이지도 DB를 갱신하지 않으면 영구 dirty로 재유입된다
  db.upsertPage({
    pageId: meta.pageId,
    spaceKey: meta.spaceKey,
    path: relPath,
    title: meta.title,
    version: updated.version,
    parentId: meta.parentId,
    contentHash: fileHashOf(updatedRaw),
    updatedAt: null
  })
  outcome.uploaded.push({ path: relPath, pageId: meta.pageId, newVersion: updated.version })

  // 첨부 업로드 동기화(ef-9): 페이지 디렉터리의 첨부 중 hash가 다른 것만 업로드
  const attachmentsDir = join(dirname(absPath), 'attachments')
  if (existsSync(attachmentsDir)) {
    for (const entry of readdirSync(attachmentsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const content = readFileSync(join(attachmentsDir, entry.name))
      const hash = fileHashOf(content)
      const known = db.listAttachmentsByPage(meta.pageId).find((record) => record.fileName === entry.name)
      if (known && known.fileHash === hash) continue
      await client.uploadAttachment(meta.pageId, entry.name, content, 'application/octet-stream')
      db.upsertAttachment({ pageId: meta.pageId, fileName: entry.name, mediaType: 'application/octet-stream', fileHash: hash })
    }
  }
}

/** push 완료 후 frontmatter의 version/syncedAt을 갱신해 파일을 다시 쓴다(본문 유지). */
function renderUpdatedFile(
  meta: { spaceKey: string; title: string; parentId: string | null; url: string },
  pageId: string,
  version: number,
  body: string
): string {
  return [
    '---',
    `pageId: ${JSON.stringify(pageId)}`,
    `spaceKey: ${JSON.stringify(meta.spaceKey)}`,
    `title: ${JSON.stringify(meta.title)}`,
    `version: ${version}`,
    `parentId: ${meta.parentId === null ? 'null' : JSON.stringify(meta.parentId)}`,
    `url: ${JSON.stringify(meta.url)}`,
    'updatedAt: null',
    `syncedAt: ${JSON.stringify(new Date().toISOString())}`,
    '---',
    '',
    body
  ].join('\n')
}
