import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConfluenceClient, ConfluenceSpace } from '../../core/confluence/client'
import { storageToMarkdown } from '../../core/converter/storageToMarkdown'
import { fileHashOf } from '../../core/store/hash'
import type { SyncStateDb } from '../../core/store/syncState'
import {
  dirSafeSpaceKey,
  pageSlug,
  renderPageFile,
  slugify,
  workspaceLayout,
} from '../../core/store/workspace'
import { reconcilePageIds } from '../../core/sync/reconciler'
import { machineFor } from './machines'
import { isAutoPullRunning, startAutoPull } from './pollCoordinator'

export interface PullResult {
  spaceKey: string
  pages: number
  attachments: number
  /** 로컬 변경(dirty) 보호로 덮어쓰지 않은 페이지 수 — 충돌 후보로 유지된다 */
  skippedDirty: number
  /** 원격에서 삭제된 페이지를 .sync/trash로 옮긴 수 */
  tombstoned: number
  /** 페이지 단위 격리로 건너뛴 실패 페이지(404·권한·첨부 오류 등) */
  failed: Array<{ pageId: string; title: string; error: string }>
}

/**
 * 스페이스 키 → 전체 pull + 자동 pull 기동(spaces:pull 핸들러 위임 본체).
 * 테스트에서 startAutoPull 기동 여부를 isAutoPullRunning으로 검증한다(B-4 회귀).
 */
export async function pullSpaceByKey(options: {
  client: ConfluenceClient
  spaceKey: string
  workspaceRoot: string
  db: SyncStateDb
}): Promise<PullResult & { autoPullStarted: boolean }> {
  const { client, spaceKey, workspaceRoot, db } = options
  const spaces = await client.listAllSpaces()
  const space = spaces.find((candidate) => candidate.key === spaceKey)
  if (!space) throw new Error(`스페이스를 찾을 수 없습니다: ${spaceKey}`)
  const result = await pullFullSpace({ client, space, workspaceRoot, db })
  startAutoPull({ client, space, workspaceRoot, db })
  return { ...result, autoPullStarted: isAutoPullRunning(spaceKey) }
}

function fileHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function sanitizeFileName(fileName: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 파일명에서 제어문자·금지문자를 치환하는 것이 목적이다
  return basename(fileName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
}

/** 연결 시 전체 pull(계획 §8.1 — 스페이스 연결 시 1회, ef-13).
 * 상태머신 락으로 agent-run·push 중 실행을 차단하고, dirty 파일은 덮어쓰지 않는다
 * (증분 pull과 동일한 보호 — 풀pull이 로컬 편집을 무단 소멸시키지 않도록).
 */
export async function pullFullSpace(options: {
  client: ConfluenceClient
  space: ConfluenceSpace
  workspaceRoot: string
  db: SyncStateDb
}): Promise<PullResult> {
  const { client, space, workspaceRoot, db } = options
  const machine = machineFor(space.key)
  const started = machine.apply('startPull')
  if (!started.ok) {
    throw new Error('이미 동기화가 진행 중입니다. 잠시 후 다시 시도하세요.')
  }
  if (started.note === 'pull-deferred') {
    throw new Error('에이전트 실행 중이거나 업로드 중입니다. 종료 후 전체 동기화하세요.')
  }

  try {
    const layout = workspaceLayout(workspaceRoot)
    const spaceRoot = join(layout.spacesRoot, dirSafeSpaceKey(space.key))
    mkdirSync(spaceRoot, { recursive: true })

    // _space.yaml: 스페이스 메타(시크릿 없음 — 토큰은 safeStorage 관리)
    writeFileSync(
      join(spaceRoot, '_space.yaml'),
      [
        `spaceKey: ${JSON.stringify(space.key)}`,
        `name: ${JSON.stringify(space.name)}`,
        `id: ${JSON.stringify(space.id)}`,
      ].join('\n'),
      'utf8',
    )

    const summaries: Array<{
      id: string
      title: string
      version: number
      parentId: string | null
    }> = await client.listAllPagesBySpace(space.id)

    // 디렉터리 배치: 계층 = Confluence 페이지 트리(§7). 같은 부모에서 슬러그
    // 충돌 시 pageId 하위 6자 접미(F1). pageId가 경로의 진실 원천.
    const dirByPageId = new Map<string, string>()
    const siblingsByParent = new Map<string | null, Set<string>>()
    const byId = new Map(summaries.map((summary) => [summary.id, summary]))

    const assignDirectory = (
      summary: { id: string; title: string; parentId?: string | null },
      trail: Set<string>,
    ): string => {
      const known = dirByPageId.get(summary.id)
      if (known) return known
      const parentKey =
        summary.parentId != null && byId.has(summary.parentId) ? summary.parentId : null
      if (parentKey !== null && trail.has(summary.id)) {
        // 순환 방어: 비정형 트리는 루트로 강등
        return assignDirectory(summary, new Set([summary.id]))
      }
      const parentDir =
        parentKey !== null
          ? assignDirectory(byId.get(parentKey)!, new Set([...trail, summary.id]))
          : `spaces/${dirSafeSpaceKey(space.key)}`
      if (!siblingsByParent.has(parentKey)) siblingsByParent.set(parentKey, new Set())
      const siblings = siblingsByParent.get(parentKey)!
      const base = slugify(summary.title)
      const slug = siblings.has(base) ? pageSlug(summary.title, summary.id, siblings) : base
      siblings.add(slug)
      const dir = `${parentDir}/${slug}`
      dirByPageId.set(summary.id, dir)
      return dir
    }

    for (const summary of summaries) assignDirectory(summary, new Set())

    let attachmentCount = 0
    let skippedDirty = 0
    const failedPulls: Array<{ pageId: string; title: string; error: string }> = []
    for (const summary of summaries) {
      try {
        const result = await pullSinglePage({
          client,
          space,
          workspaceRoot,
          db,
          summary,
          dir: dirByPageId.get(summary.id)!,
        })
        attachmentCount += result.attachments
        if (result.skipped) skippedDirty += 1
      } catch (cause) {
        // 페이지 단위 격리: 한 페이지 실패(404·권한·첨부 오류·디스크)가
        // 스페이스 전체 pull과 tombstone 대차를 중단시키지 않는다.
        failedPulls.push({
          pageId: summary.id,
          title: summary.title,
          error: String(cause instanceof Error ? cause.message : cause),
        })
      }
    }

    // 원격 삭제 대차(F-3): 전체 목록이 있으므로 풀pull에서 tombstone 처리한다
    const reconciliation = reconcilePageIds({
      spaceKey: space.key,
      remotePageIds: summaries.map((summary) => summary.id),
      db,
      workspaceRoot,
      trashDir: join(workspaceRoot, '.sync', 'trash'),
      now: new Date(),
    })

    return {
      spaceKey: space.key,
      pages: summaries.length - failedPulls.length,
      attachments: attachmentCount,
      skippedDirty,
      tombstoned: reconciliation.tombstoned.length,
      failed: failedPulls,
    }
  } finally {
    machine.apply('endPull')
  }
}

export interface PageSummaryLike {
  id: string
  title: string
  version: number
  parentId: string | null
}

/** 단일 페이지 + 첨부를 내려받아 워크스페이스에 기록한다(전체/증분 pull 공용).
 * 로컬 파일이 db 해시와 다르면(dirty = 미푸시 편집) 덮어쓰지 않고 skipped로 반환한다 —
 * 해시까지 갱신하면 충돌 후보 스캔에서 영구 유실된다(증분 경로와 동일 기준).
 */
export async function pullSinglePage(options: {
  client: ConfluenceClient
  space: ConfluenceSpace
  workspaceRoot: string
  db: SyncStateDb
  summary: PageSummaryLike
  dir: string
}): Promise<{ attachments: number; skipped: boolean }> {
  const { client, space, workspaceRoot, db, summary, dir } = options
  const indexAbsPath = join(workspaceRoot, dir, 'index.md')

  // dirty 보호: 로컬 hash가 last-synced와 다르면 건드리지 않는다
  const record = db.getPage(summary.id)
  if (record?.contentHash && existsSync(indexAbsPath)) {
    if (fileHashOf(readFileSync(indexAbsPath)) !== record.contentHash) {
      return { attachments: 0, skipped: true }
    }
  }

  let attachmentCount = 0
  const detail = await client.getPageStorage(summary.id)
  const { markdown } = storageToMarkdown(detail.storageValue)

  const indexRelPath = `${dir}/index.md`
  mkdirSync(dirname(indexAbsPath), { recursive: true })

  const raw = renderPageFile(
    {
      pageId: detail.id,
      spaceKey: space.key,
      title: detail.title,
      version: detail.version,
      parentId: summary.parentId,
      url: `${client.identity.baseUrl}/wiki/spaces/${space.key}/pages/${detail.id}`,
      updatedAt: null,
      syncedAt: new Date().toISOString(),
    },
    markdown,
  )
  writeFileSync(indexAbsPath, raw, 'utf8')

  db.upsertPage({
    pageId: detail.id,
    spaceKey: space.key,
    path: indexRelPath,
    title: detail.title,
    version: detail.version,
    parentId: summary.parentId,
    contentHash: fileHash(raw),
    updatedAt: null,
  })

  const attachments = await client.listAttachments(detail.id)
  const attachmentAbsDir = join(workspaceRoot, `${dir}/attachments`)
  for (const attachment of attachments) {
    const fileName = sanitizeFileName(attachment.fileName)
    const absPath = join(attachmentAbsDir, fileName)
    if (!existsSync(absPath)) {
      const buffer = Buffer.from(
        await client.downloadAttachment(
          attachment.downloadPath ?? `download/attachments/${attachment.id}/${fileName}`,
        ),
      )
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, buffer)
      attachmentCount += 1
    }
    db.upsertAttachment({
      pageId: detail.id,
      fileName,
      mediaType: attachment.mediaType,
      fileHash: fileHash(readFileSync(absPath)),
    })
  }
  return { attachments: attachmentCount, skipped: false }
}
