/**
 * 워크스페이스 폴더 규약(계획 §7).
 * 레이아웃·슬러그·동기 대상 allowlist·frontmatter 코덱의 단일 소스.
 */
export interface WorkspaceLayout {
  root: string
  settingsFile: string // confluence.yaml
  syncDir: string // .sync/
  stateDb: string // .sync/sync-state.db
  trashDir: string // .sync/trash/<ts>/
  spacesRoot: string // spaces/
}

export function workspaceLayout(root: string): WorkspaceLayout {
  const p = (parts: string[]) => [root, ...parts].join('/')
  return {
    root,
    settingsFile: p(['confluence.yaml']),
    syncDir: p(['.sync']),
    stateDb: p(['.sync', 'sync-state.db']),
    trashDir: p(['.sync', 'trash']),
    spacesRoot: p(['spaces']),
  }
}

export function spaceDir(layout: WorkspaceLayout, spaceKey: string): string {
  return `${layout.spacesRoot}/${spaceKey}`
}

/**
 * 스페이스 키 → 디렉터리명 안전화: 개인 스페이스 키의 선행 `~`는
 * Claude Code 보안 검사에서 홈 디렉터리 패턴으로 오탐되므로 `personal-`로 치환.
 * db·frontmatter의 space_key는 원본 키를 유지하고 디렉터리명만 안전화한다.
 */
export function dirSafeSpaceKey(spaceKey: string): string {
  return spaceKey.replace(/^~/, 'personal-')
}

/**
 * 제목 → 파일시스템 안전 슬러그:
 * NFC 정규화, OS 금지문자/제어문자 제거, 공백→하이픈, 최대 80자.
 * 한글 등 유니코드 문자는 파일시스템에서 안전하므로 보존한다.
 */
export function slugify(title: string): string {
  const nfc = title.normalize('NFC')
  const cleaned = nfc
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 제목에서 제어문자·금지문자를 제거하는 것이 목적이다
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/[\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const truncated = cleaned.slice(0, 80).replace(/-$/g, '')
  return truncated.length > 0 ? truncated : 'page'
}

const OS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

/** 슬러그 충돌 병합 규칙(F1): 동일 부모에서 충돌 시 `slug-<pageId 하위 6자>`. */
export function pageSlug(title: string, pageId: string, siblingSlugs: Set<string>): string {
  const base = slugify(title)
  const probe = OS_RESERVED.has(base.toUpperCase()) ? `${base}-p` : base
  if (!siblingSlugs.has(probe)) return probe
  const suffix = pageId.slice(-6)
  return `${probe}-${suffix}`
}

/**
 * 동기 대상 allowlist(F3/F-12): 이 두 패턴만 변경 감지·push 후보가 된다.
 * .sync/, confluence.yaml, _space.yaml, *.local-*.md, *.remote.md는
 * allowlist 특성상 애초에 대상이 아니다(유령 페이지 유입 차단).
 */
export function isSyncTarget(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  // 경로 탈출(QA P1) 차단: '..' 세그먼트와 절대화 시도는 전부 거부
  if (segments.includes('..') || normalized.includes('\\0')) return false
  if (segments[0] === '.sync' || segments[0] !== 'spaces') return false
  if (segments.includes('.sync')) return false
  if (normalized === 'confluence.yaml') return false
  const fileName = segments[segments.length - 1] ?? ''
  if (fileName === '_space.yaml') return false
  if (/\.local-[\w-]+\.md$/.test(fileName)) return false
  if (/\.remote\.md$/.test(fileName)) return false
  if (fileName === 'index.md') return true
  // attachments는 정확히 'attachments/<파일>' 세그먼트 쌍으로만 허용(서브스트링 우회 금지)
  const attachmentsIndex = segments.indexOf('attachments')
  if (attachmentsIndex === segments.length - 2 && attachmentsIndex >= 2) return true
  return false
}

// ── frontmatter 코덱(플랫 스키마 한정: pageId/spaceKey/title/version/parentId/url/updatedAt/syncedAt) ──

export interface PageFrontmatter {
  pageId: string
  spaceKey: string
  title: string
  version: number
  parentId: string | null
  url: string
  updatedAt: string | null
  syncedAt: string | null
}

/** 값은 항상 JSON 문자열로 인용(콜론·한글 안전), 숫자(version)만 비인용. */
export function renderPageFile(meta: PageFrontmatter, markdownBody: string): string {
  const lines = [
    '---',
    `pageId: ${JSON.stringify(meta.pageId)}`,
    `spaceKey: ${JSON.stringify(meta.spaceKey)}`,
    `title: ${JSON.stringify(meta.title)}`,
    `version: ${meta.version}`,
    `parentId: ${meta.parentId === null ? 'null' : JSON.stringify(meta.parentId)}`,
    `url: ${JSON.stringify(meta.url)}`,
    `updatedAt: ${meta.updatedAt === null ? 'null' : JSON.stringify(meta.updatedAt)}`,
    `syncedAt: ${meta.syncedAt === null ? 'null' : JSON.stringify(meta.syncedAt)}`,
    '---',
    '',
    markdownBody,
  ]
  return lines.join('\n')
}

export function parsePageFile(raw: string): { meta: PageFrontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) throw new Error('frontmatter가 없는 페이지 파일입니다')
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) throw new Error('frontmatter 종료 마커가 없습니다')
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 5).replace(/^\n+/, '')

  const values = new Map<string, string>()
  for (const line of header.split('\n')) {
    const eq = line.indexOf(':')
    if (eq === -1) continue
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const requireValue = (key: string): string => {
    const v = values.get(key)
    if (v === undefined) throw new Error(`frontmatter에 ${key}가 없습니다`)
    return parseScalar(v)
  }
  return {
    meta: {
      pageId: requireValue('pageId'),
      spaceKey: requireValue('spaceKey'),
      title: requireValue('title'),
      version: Number(requireValue('version')),
      parentId:
        parseScalar(values.get('parentId') ?? 'null') === 'null'
          ? null
          : parseScalar(values.get('parentId')!),
      url: requireValue('url'),
      updatedAt:
        parseScalar(values.get('updatedAt') ?? 'null') === 'null'
          ? null
          : parseScalar(values.get('updatedAt')!),
      syncedAt:
        parseScalar(values.get('syncedAt') ?? 'null') === 'null'
          ? null
          : parseScalar(values.get('syncedAt')!),
    },
    body,
  }
}

function parseScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}
