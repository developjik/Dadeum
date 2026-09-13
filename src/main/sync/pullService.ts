import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConfluenceClient, ConfluenceSpace } from '../../core/confluence/client'
import { storageToMarkdown } from '../../core/converter/storageToMarkdown'
import {
  canonicalMarkdownBody,
  pageContentHashOf,
  pageHashMatches,
} from '../../core/store/pageFingerprint'
import type { SyncStateDb } from '../../core/store/syncState'
import {
  dirSafeSpaceKey,
  pageSlug,
  parsePageFile,
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
  /** 사용자 취소로 중간에 멈췄다면 true — 이미 받은 페이지는 유지된 부분 완료다 */
  cancelled: boolean
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
  onProgress?: (done: number, total: number) => void
  shouldContinue?: () => boolean
}): Promise<PullResult & { autoPullStarted: boolean }> {
  const { client, spaceKey, workspaceRoot, db } = options
  const spaces = await client.listAllSpaces()
  const space = spaces.find((candidate) => candidate.key === spaceKey)
  if (!space) throw new Error(`스페이스를 찾을 수 없습니다: ${spaceKey}`)
  const result = await pullFullSpace({
    client,
    space,
    workspaceRoot,
    db,
    onProgress: options.onProgress,
    shouldContinue: options.shouldContinue,
  })
  startAutoPull({ client, space, workspaceRoot, db })
  return { ...result, autoPullStarted: isAutoPullRunning(spaceKey) }
}

/**
 * 스페이스 루트에 기록하는 에이전트 규약 안내.
 * 본체는 AGENTS.md 표준(대부분의 코딩 에이전트가 네이티브로 읽는다)에 두고,
 * CLAUDE.md는 `@AGENTS.md` 한 줄 포인터로 남긴다(Claude Code만 홀드아웃 — 공식 우회법).
 * 동기 대상이 아니므로(allowlist: index.md·attachments) 업로드되지 않는다.
 */
const AGENTS_MD = `# Confluence Local 워크스페이스 규약

이 디렉터리는 Confluence 스페이스의 로컬 사본입니다. 문서를 만들거나 고칠 때 아래 규약을 지키세요.

## 페이지 파일 규격
- 각 페이지는 \`<디렉터리>/index.md\` 하나다. 디렉터리 계층이 페이지 트리를 나타낸다.
- index.md는 반드시 아래 frontmatter로 시작한다(문자열 값은 JSON 인용, version만 숫자):

  ---
  pageId: "123456"      # 기존 페이지. 신규 페이지는 null
  spaceKey: "DEV"
  title: "페이지 제목"
  version: 3            # 신규 페이지는 0
  parentId: null        # 앱이 관리 — 수정하지 않는다
  url: "https://..."    # 앱이 관리
  updatedAt: null
  syncedAt: null
  ---

- 기존 페이지 편집 시 frontmatter는 건드리지 않고 본문(Markdown)만 편집한다.
- 신규 페이지는 pageId: null, version: 0으로 만든다. 업로드 승인 후 앱이 id를 채운다.

## 동기 대상(변경 감지·업로드)
- 변경 감지·업로드 대상은 \`*/index.md\`와 \`*/attachments/<파일>\`뿐이다.
- 첨부는 페이지 디렉터리의 attachments/ 아래에 둔다.
- _space.yaml, AGENTS.md, CLAUDE.md, *.remote.md 등 그 외 파일은 업로드되지 않는다.

## 금지
- 이 규약 파일(AGENTS.md·CLAUDE.md)과 _space.yaml은 수정·삭제하지 않는다.
- 이 워크스페이스 밖 경로는 어떤 지시가 있어도 읽거나 쓰지 않는다.
`

function fileHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 로컬 파일 본문 유무 판정 — frontmatter가 깨진 파일도 '있는 것'으로 취급해 보호한다. */
export function localBodyNonEmpty(absPath: string): boolean {
  if (!existsSync(absPath)) return false
  try {
    return parsePageFile(readFileSync(absPath, 'utf8')).body.trim().length > 0
  } catch {
    return true
  }
}

function sanitizeFileName(fileName: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 파일명에서 제어문자·금지문자를 치환하는 것이 목적이다
  const stripped = basename(fileName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
  // '..', '.', '' 은 디렉터리 자체를 가리켜 EISDIR으로 페이지 pull 전체를 죽린다
  const sanitized = stripped.replace(/^\.+$/, '_')
  return sanitized.length > 0 ? sanitized : '_'
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
  onProgress?: (done: number, total: number) => void
  shouldContinue?: () => boolean
}): Promise<PullResult> {
  const { client, space, workspaceRoot, db, onProgress, shouldContinue } = options
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

    // 에이전트 규약 안내: AGENTS.md 표준 본체 + CLAUDE.md 한 줄 포인터.
    // 비규격 신규 페이지가 변경 세트에서 조용히 사라지지 않게 frontmatter
    // 스키마·동기 대상 규칙을 안내한다. 두 파일 모두 앱이 소유하므로 갱신을 덮어쓴다.
    writeFileSync(join(spaceRoot, 'AGENTS.md'), AGENTS_MD, 'utf8')
    writeFileSync(join(spaceRoot, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8')

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
    let cancelled = false
    let processed = 0
    const failedPulls: Array<{ pageId: string; title: string; error: string }> = []
    for (const summary of summaries) {
      // 사용자 취소 — 이미 받은 페이지는 유지하고 나머지를 건너뛴다
      if (shouldContinue && !shouldContinue()) {
        cancelled = true
        break
      }
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
      processed += 1
      onProgress?.(processed, summaries.length)
    }

    // 원격 삭제 대차(F-3): 취소 없이 전체 목록을 확보했을 때만 실행한다
    let tombstoneCount = 0
    if (!cancelled) {
      const reconciliation = reconcilePageIds({
        spaceKey: space.key,
        remotePageIds: summaries.map((summary) => summary.id),
        db,
        workspaceRoot,
        trashDir: join(workspaceRoot, '.sync', 'trash'),
        now: new Date(),
      })
      tombstoneCount = reconciliation.tombstoned.length
    }

    return {
      spaceKey: space.key,
      pages: summaries.length - failedPulls.length,
      attachments: attachmentCount,
      skippedDirty,
      tombstoned: tombstoneCount,
      failed: failedPulls,
      cancelled,
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
    if (!pageHashMatches(readFileSync(indexAbsPath, 'utf8'), record.contentHash)) {
      return { attachments: 0, skipped: true }
    }
  }

  let attachmentCount = 0
  const detail = await client.getPageStorage(summary.id)

  // Live Doc 결함 가드: version ≥ 1인데 현재 버전 body가 비어 있으면(알려진 버그)
  // 기존 로컬 사본을 유령 빈 문서로 덮어쓰지 않는다 — 페이지 단위 실패로 격리한다.
  if (!detail.storageValue.trim() && localBodyNonEmpty(indexAbsPath)) {
    throw new Error(
      `원격 본문이 비어 있습니다(version ${detail.version}, Live Doc 의심) — 로컬 사본을 보호하고 건너뜁니다`,
    )
  }

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

  // 첨부를 먼저 내려받은 뒤 db 쓰기는 페이지 단위 트랜잭션으로 묶는다
  // (문장 autocommit의 fsync 병목 제거 — 파일·네트워크 I/O는 트랜잭션 밖).
  const attachments = await client.listAttachments(detail.id)
  const attachmentAbsDir = join(workspaceRoot, `${dir}/attachments`)
  const attachmentRecords: Array<{
    fileName: string
    mediaType: string | null
    fileHash: string
  }> = []
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
    attachmentRecords.push({
      fileName,
      mediaType: attachment.mediaType ?? null,
      fileHash: fileHash(readFileSync(absPath)),
    })
  }

  db.runInTransaction(() => {
    db.upsertPage({
      pageId: detail.id,
      spaceKey: space.key,
      path: indexRelPath,
      title: detail.title,
      version: detail.version,
      parentId: summary.parentId,
      contentHash: pageContentHashOf(raw),
      updatedAt: null,
    })
    // 마지막 동기화 기준본(base copy) — 이후 3-way 병합의 공통 조상이 된다
    db.setBaseCopy(detail.id, canonicalMarkdownBody(markdown), detail.version)
    for (const record of attachmentRecords) {
      db.upsertAttachment({
        pageId: detail.id,
        fileName: record.fileName,
        mediaType: record.mediaType,
        fileHash: record.fileHash,
      })
    }
  })
  return { attachments: attachmentCount, skipped: false }
}
