import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import type { SyncStateDb, PageRecord } from '../store/syncState'
import { dirSafeSpaceKey, isSyncTarget, parsePageFile } from '../store/workspace'

/**
 * 변경 세트 산출(계획 §8.3-1): allowlist 파일을 스캔해 db 해시와 비교한다.
 * - modified: db에 있고 content_hash가 바뀐 페이지
 * - added: db에 없는 새 index.md(frontmatter 파싱 성공 = 새 페이지 후보)
 * - missing: db에 있는데 파일이 사라진 페이지(사용자 안내 대상)
 */
export interface ModifiedPage {
  path: string
  pageId: string
  oldHash: string | null
  newHash: string
}

export interface AddedPage {
  path: string
  title: string
}

export interface ChangedAttachment {
  path: string
  pageId: string
  fileName: string
  newHash: string
}

export interface ChangeSet {
  modified: ModifiedPage[]
  added: AddedPage[]
  missing: PageRecord[]
  attachments: ChangedAttachment[]
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function computeChangeSet(workspaceRoot: string, db: SyncStateDb, spaceKey: string): ChangeSet {
  const spaceRoot = join(workspaceRoot, 'spaces', dirSafeSpaceKey(spaceKey))
  const indexFiles = walkIndexFiles(spaceRoot, workspaceRoot)

  const seenDirs = new Set<string>()
  const modified: ModifiedPage[] = []
  const added: AddedPage[] = []
  const attachments: ChangedAttachment[] = []

  for (const absPath of indexFiles) {
    const relPath = absPath.slice(workspaceRoot.length + 1)
    seenDirs.add(relPath.replace(/\/index\.md$/, ''))
    const raw = readFileSync(absPath, 'utf8')
    const hash = sha256(raw)

    let pageId: string | null = null
    let title = ''
    try {
      const parsed = parsePageFile(raw)
      pageId = parsed.meta.pageId
      title = parsed.meta.title
    } catch {
      continue // frontmatter 없는 파일은 동기 후보 아님(allowlist라도)
    }

    const record = db.getPage(pageId)
    if (!record) {
      added.push({ path: relPath, title })
    } else if (record.contentHash !== hash) {
      modified.push({ path: relPath, pageId, oldHash: record.contentHash, newHash: hash })
    }

    // 첨부 스캔(ef-9): 이 페이지 디렉터리의 attachments를 db와 비교
    const attachmentsAbs = join(dirname(absPath), 'attachments')
    if (existsSync(attachmentsAbs)) {
      const known = pageId !== null && /^\d+$/.test(pageId) ? db.listAttachmentsByPage(pageId) : []
      for (const entry of readdirSync(attachmentsAbs, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const attRel = `${relPath.replace(/index\.md$/, 'attachments')}/${entry.name}`
        const content = readFileSync(join(attachmentsAbs, entry.name))
        const attHash = sha256(content)
        const rec = known.find((r) => r.fileName === entry.name)
        if (!rec || rec.fileHash !== attHash) {
          attachments.push({ path: attRel, pageId: pageId ?? '', fileName: entry.name, newHash: attHash })
        }
      }
    }
  }

  const missing = db.listPagesBySpace(spaceKey).filter((page) => {
    if (page.remoteDeleted) return false
    const dir = page.path.replace(/\/index\.md$/, '')
    return !seenDirs.has(dir) || !existsSync(join(workspaceRoot, page.path))
  })

  return { modified, added, missing, attachments }
}

function walkIndexFiles(absDir: string, rootDir: string): string[] {
  if (!existsSync(absDir)) return []
  const found: string[] = []
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'attachments') continue // 첨부는 본문 변경 세트가 아니다
      found.push(...walkIndexFiles(abs, rootDir))
    } else if (entry.isFile()) {
      const rel = abs.slice(rootDir.length + 1)
      if (isSyncTarget(rel) && rel.endsWith('index.md')) found.push(abs)
    }
  }
  return found
}
