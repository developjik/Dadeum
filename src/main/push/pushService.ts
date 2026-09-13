import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfluenceClient } from '../../core/confluence/client'
import { ConfluenceApiError } from '../../core/confluence/types'
import { markdownToStorage } from '../../core/converter/markdownToStorage'
import { storageToMarkdown } from '../../core/converter/storageToMarkdown'
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
import { fileHashOf } from '../../core/store/hash'
import { canonicalMarkdownBody, pageContentHashOf } from '../../core/store/pageFingerprint'
import type { SyncStateDb } from '../../core/store/syncState'
import { parsePageFile } from '../../core/store/workspace'
import type { SpaceStateMachine } from '../../core/sync/spaceStateMachine'

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
  const outcome: PushOutcome = {
    uploaded: [],
    conflicts: [],
    remoteDeleted: [],
    failed: [],
    deletedAttachments: [],
    skippedRemoteAttachments: [],
  }

  // 1차 가드: 상태머신(agent-run/pulling/pushing 중 금지 — F-2)
  if (!machine.canStartPush()) {
    outcome.failed.push({
      path: '(전체)',
      error: '에이전트 실행 중이거나 동기화가 진행 중이라 push할 수 없습니다',
    })
    return outcome
  }

  // 2차 가드: 승인 스냅샷 재검증(승인 후 파일 변경 시 재 diff 강제)
  const verification = verifySnapshot(workspaceRoot, snapshot)
  if (!verification.ok) {
    for (const path of verification.mismatched) {
      outcome.failed.push({
        path,
        error: '승인 후 파일이 변경되었습니다. 다시 검토(diff)하고 승인하세요.',
      })
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
      // 페이지별 업로드 직전 해시 재검증 — 직전 페이지의 네트워크 I/O 사이에 파일이
      // 바뀌면(외부 편집기 등) 승인 무결성이 깨지므로 나머지를 즉시 중단한다.
      const entry = snapshot.entries.get(relPath)
      const absPath = join(workspaceRoot, relPath)
      if (
        !entry ||
        !existsSync(absPath) ||
        fileHashOf(readFileSync(absPath, 'utf8')) !== entry.hash
      ) {
        outcome.failed.push({
          path: relPath,
          error: '업로드 도중 파일이 변경되었습니다. 다시 검토(diff)하고 승인하세요.',
        })
        break
      }
      try {
        await pushOne({ client, workspaceRoot, db, spaceId, relPath }, outcome)
      } catch (cause) {
        outcome.failed.push({
          path: relPath,
          error: String(cause instanceof Error ? cause.message : cause),
        })
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

/**
 * 로컬 디렉터리 위치에서 부모 페이지 이동 요청을 산출한다.
 * - 경로의 부모 디렉터리에 db에 있는 페이지(db = pageId 진실 원천)가 있으면 그 아래로 이동
 * - 스페이스 루트면 parentType 'space'로 이동
 * - 부모가 아직 push되지 않은 신규 페이지면 이동 요청을 생략한다(순서 보장 불가)
 */
function parentMoveRequest(context: {
  db: SyncStateDb
  spaceId: string
  relPath: string
  meta: { pageId: string; parentId: string | null }
}): { parentId: string; parentType: 'page' | 'space' } | undefined {
  const { db, spaceId, relPath, meta } = context
  const record = db.getPage(meta.pageId)
  if (!record) return undefined // 신규 생성 페이지(이동 개념 없음)

  const dir = relPath.replace(/\/index\.md$/, '')
  const lastSlash = dir.lastIndexOf('/')
  const parentIndexPath =
    lastSlash > 'spaces/'.length ? `${dir.slice(0, lastSlash)}/index.md` : null

  if (parentIndexPath === null) {
    // 스페이스 루트로 이동(또는 유지) — record.parentId가 이미 null이면 요청 불필요
    if (record.parentId === null) return undefined
    return { parentId: spaceId, parentType: 'space' }
  }
  const parent = db.getPageByPath(parentIndexPath)
  if (!parent || !/^\d+$/.test(parent.pageId)) return undefined // 부모 미푸시 — 생략
  if (parent.pageId === record.parentId) return undefined // 이동 없음
  return { parentId: parent.pageId, parentType: 'page' }
}

async function pushOne(
  context: {
    client: ConfluenceClient
    workspaceRoot: string
    db: SyncStateDb
    spaceId: string
    relPath: string
  },
  outcome: PushOutcome,
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
  const pageIdIsNumeric = /^\d+$/.test(meta.pageId)
  if (pageIdIsNumeric) {
    try {
      const remote = await client.getPageStorage(meta.pageId)
      remoteVersion = remote.version
    } catch (cause) {
      if (
        cause instanceof Error &&
        'status' in cause &&
        (cause as { status?: number }).status === 404
      ) {
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
    let parentId = meta.parentId && /^\d+$/.test(meta.parentId) ? meta.parentId : undefined
    if (!parentId) {
      // 디렉터리 계층 = 페이지 트리(§7): 경로상 부모 index.md의 pageId로 계층을 복원한다
      // (스페이스 루트 생성 방지 — 부모 없이 만들면 계층 복원이 무기한 미뤄진다)
      const parentRel = relPath.replace(/\/[^/]+\/index\.md$/, '/index.md')
      const parentAbs = join(workspaceRoot, parentRel)
      if (parentRel !== relPath && existsSync(parentAbs)) {
        const parentPageId = parsePageFile(readFileSync(parentAbs, 'utf8')).meta.pageId
        if (/^\d+$/.test(parentPageId)) parentId = parentPageId
      }
    }
    const created = await client.createPage({ spaceId, parentId, title: meta.title, storageValue })
    if (created.version !== 1) {
      throw new Error(`신규 생성 응답 버전이 비정상입니다: ${created.version}`)
    }
    // REST 생성 페이지는 legacy editor 취급될 수 있다(사용자 저장 시 첨부 참조가
    // UNKNOWN_ATTACHMENT로 재작성되는 결함) — editor=v2 속성을 심는다(최선 노력).
    try {
      await client.setPageContentProperty(created.pageId, 'editor', 'v2')
    } catch {
      // 속성 설정 실패가 이미 완료된 생성을 되돌리지는 않는다
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
      contentHash: pageContentHashOf(createdRaw),
    })
    db.setBaseCopy(created.pageId, canonicalMarkdownBody(body), created.version)
    outcome.uploaded.push({ path: relPath, pageId: created.pageId, newVersion: created.version })

    // 신규 페이지 첨부 동기화(생성 후 즉시 업로드)
    const attachmentsDir = join(dirname(absPath), 'attachments')
    if (existsSync(attachmentsDir)) {
      for (const entry of readdirSync(attachmentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const content = readFileSync(join(attachmentsDir, entry.name))
        const hash = fileHashOf(content)
        await client.uploadAttachment(
          created.pageId,
          entry.name,
          content,
          'application/octet-stream',
        )
        db.upsertAttachment({
          pageId: created.pageId,
          fileName: entry.name,
          mediaType: 'application/octet-stream',
          fileHash: hash,
        })
      }
    }
    return
  }

  // 기존 페이지 수정: 요청 버전 명시(remoteVersion === meta.version 보장)
  // 제목은 로컬 frontmatter를 우선한다 — 사용자의 로컬 rename이 조용히 무시되지 않도록.
  const expectedRemote = remoteVersion ?? meta.version
  const moveRequest = parentMoveRequest({ db, spaceId, relPath, meta })
  let updated: Awaited<ReturnType<typeof client.updatePage>>
  try {
    updated = await client.updatePage({
      pageId: meta.pageId,
      currentVersion: expectedRemote,
      title: meta.title,
      storageValue,
      ...moveRequest,
    })
  } catch (cause) {
    // 사전 검사(GET)와 PUT 사이에 원격이 바뀐 좁은 창(409) — 실패가 아니라 충돌로 분류해
    // 사용자가 충돌 해결 UI로 안내받게 한다. 현재 원격 버전을 재조회해 함께 보고한다.
    if (cause instanceof ConfluenceApiError && cause.kind === 'conflict') {
      const current = await client.getPageStorage(meta.pageId)
      outcome.conflicts.push({ path: relPath, pageId: meta.pageId, remoteVersion: current.version })
      return
    }
    throw cause
  }
  // 반영 성공 판정(AC-4): 응답 버전 == 기대+1
  if (updated.version !== expectedRemote + 1) {
    throw new Error(`버전 증가 확인 실패: 기대 ${expectedRemote + 1}, 응답 ${updated.version}`)
  }
  // 반영 검증(침묵 no-op 방지 — 동일 내용 PUT이 조용히 무시되는 결함 대비):
  // 재조회한 원격을 마크다운으로 되돌려 정규화 비교한다. md→storage→md 멱등성이
  // 서버 저장본과 업로드 본문의 동치 판정을 보장한다.
  const verified = await client.getPageStorage(meta.pageId)
  if (verified.version !== updated.version) {
    throw new Error(
      `반영 검증 실패: 서버 버전이 응답(${updated.version})과 다릅니다(${verified.version}). 다시 검토하세요.`,
    )
  }
  if (
    canonicalMarkdownBody(storageToMarkdown(verified.storageValue).markdown) !==
    canonicalMarkdownBody(body)
  ) {
    throw new Error(
      '반영 검증 실패: 서버에 저장된 내용이 업로드한 본문과 다릅니다. 변경 세트를 다시 검토하세요.',
    )
  }
  // 이동 push가 반영됐으면 frontmatter·db의 parentId도 새 위치로 맞춘다
  const effectiveParentId = moveRequest
    ? moveRequest.parentType === 'page'
      ? moveRequest.parentId
      : null
    : meta.parentId

  const updatedRaw = renderUpdatedFile(
    { ...meta, parentId: effectiveParentId },
    meta.pageId,
    updated.version,
    body,
  )
  writeFileSync(absPath, updatedRaw, 'utf8')
  // B-7: 기존 페이지도 DB를 갱신하지 않으면 영구 dirty로 재유입된다
  db.upsertPage({
    pageId: meta.pageId,
    spaceKey: meta.spaceKey,
    path: relPath,
    title: meta.title,
    version: updated.version,
    parentId: effectiveParentId,
    contentHash: pageContentHashOf(updatedRaw),
    updatedAt: null,
  })
  db.setBaseCopy(meta.pageId, canonicalMarkdownBody(body), updated.version)
  outcome.uploaded.push({ path: relPath, pageId: meta.pageId, newVersion: updated.version })

  // 첨부 업로드 동기화(ef-9): 페이지 디렉터리의 첨부 중 hash가 다른 것만 업로드
  const attachmentsDir = join(dirname(absPath), 'attachments')
  if (existsSync(attachmentsDir)) {
    for (const entry of readdirSync(attachmentsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const content = readFileSync(join(attachmentsDir, entry.name))
      const hash = fileHashOf(content)
      const known = db
        .listAttachmentsByPage(meta.pageId)
        .find((record) => record.fileName === entry.name)
      if (known && known.fileHash === hash) continue
      await client.uploadAttachment(meta.pageId, entry.name, content, 'application/octet-stream')
      db.upsertAttachment({
        pageId: meta.pageId,
        fileName: entry.name,
        mediaType: 'application/octet-stream',
        fileHash: hash,
      })
    }
  }

  // 첨부 삭제 동기화: 'db가 과거에 동기화한 첨부'가 로컬에서 사라졌을 때만 원격에서 정리한다.
  // 한 번도 내려받은 적 없는 원격 첨부(첨부는 페이지 버전을 올리지 않아 버전 게이트가
  // 못 잡는다)를 지우면 사용자가 본 적도 없는 데이터가 영구 삭제된다 — 보존하고 결과에 보고.
  // attachments/ 디렉터리째 삭제도 '전부 삭제' 의도로 해석한다 — 디렉터리가 없으면 빈 집합으로 대사한다.
  const knownRecords = db.listAttachmentsByPage(meta.pageId)
  const localNames = new Set(
    existsSync(attachmentsDir)
      ? readdirSync(attachmentsDir, { withFileTypes: true }).map((e) => e.name)
      : [],
  )
  const remoteAttachments = await client.listAttachments(meta.pageId)
  for (const remote of remoteAttachments) {
    if (localNames.has(remote.fileName)) continue
    if (!knownRecords.some((record) => record.fileName === remote.fileName)) {
      outcome.skippedRemoteAttachments.push({
        path: relPath.replace(/index\.md$/, `attachments/${remote.fileName}`),
        fileName: remote.fileName,
      })
      continue
    }
    await client.deleteAttachment(remote.id)
    db.deleteAttachment(meta.pageId, remote.fileName)
    outcome.deletedAttachments.push({
      path: relPath.replace(/index\.md$/, `attachments/${remote.fileName}`),
      fileName: remote.fileName,
    })
  }
}

/** push 완료 후 frontmatter의 version/syncedAt을 갱신해 파일을 다시 쓴다(본문 유지). */
function renderUpdatedFile(
  meta: { spaceKey: string; title: string; parentId: string | null; url: string },
  pageId: string,
  version: number,
  body: string,
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
    body,
  ].join('\n')
}
