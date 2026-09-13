import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSyncTarget } from '../store/workspace'

/**
 * 승인 시점 스냅샷(F-2, TOCTOU 차단):
 * 승인 순간의 파일 바이트를 hash로 고정하고, 업로드 직전에 재검증한다.
 * 승인 후 파일이 바뀌었으면 업로드를 거부하고 재 diff를 강제한다.
 */
export interface ApprovalSnapshot {
  capturedAt: string
  entries: Map<string, { hash: string }>
}

export function captureSnapshot(workspaceRoot: string, approvedPaths: string[]): ApprovalSnapshot {
  const entries = new Map<string, { hash: string }>()
  for (const relPath of approvedPaths) {
    if (!isSyncTarget(relPath))
      throw new Error(`동기 대상이 아닌 경로는 승인할 수 없습니다: ${relPath}`)
    const abs = join(workspaceRoot, relPath)
    const content = readFileSync(abs)
    entries.set(relPath, { hash: createHash('sha256').update(content).digest('hex') })
  }
  return { capturedAt: new Date().toISOString(), entries }
}

export interface FsAdapter {
  existsSync(path: string): boolean
  readFileSync(path: string): Buffer
}

const defaultFs: FsAdapter = { existsSync, readFileSync }

/** 업로드 직전 재검증: 현재 파일이 스냅샷과 동일한지(불일치 목록 반환). */
export function verifySnapshot(
  workspaceRoot: string,
  snapshot: ApprovalSnapshot,
  fs: FsAdapter = defaultFs,
): { ok: boolean; mismatched: string[] } {
  const mismatched: string[] = []
  for (const [relPath, entry] of snapshot.entries) {
    const abs = join(workspaceRoot, relPath)
    if (!fs.existsSync(abs)) {
      mismatched.push(relPath)
      continue
    }
    const hash = createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    if (hash !== entry.hash) mismatched.push(relPath)
  }
  return { ok: mismatched.length === 0, mismatched }
}
