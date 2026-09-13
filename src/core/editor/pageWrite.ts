/**
 * 페이지 본문 직접 저장(코어 — electron 의존 없음, node fs만 사용).
 * renderer는 본문(body)만 다룬다: frontmatter는 main이 파일에서 다시 읽어
 * 그대로 재직렬화하므로 pageId·version 등 메타가 사용자 편집으로 변질되지 않는다.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { markdownToStorage } from '../converter/markdownToStorage'
import { assertSyncPagePath, isWithinRoot, parsePageFile, renderPageFile } from '../store/workspace'

/** 저장 게이트 결과 — pages:read 결과와 같은 모양으로 저장 직후 미리보기를 갱신한다. */
export interface WrittenPage {
  pageId: string
  title: string
  url: string
  version: number
  markdown: string
}

/** 비정상 대형 페이로드 방지(구조화 복제 비용·파일 파손 완충). */
const MAX_PAGE_BODY_CHARS = 2_000_000

/**
 * 페이지 파일의 본문을 교체한다(계획 §7 워크스페이스 규약 준수).
 * - 경로는 allowlist 게이트(assertSyncPagePath)를 통과해야 한다
 * - 저장 시점에 push 변환(markdownToStorage)을 돌려본다 — 저장 게이트 = push 게이트.
 *   캐리어 펜스 내용이 변질됐다면 여기서 거부한다
 * - 쓰기는 임시 파일 + rename 원자 교체로 한다(.tmp-*는 allowlist 밖이라 유령 페이지 없음)
 */
export function writePageBody(
  workspaceRoot: string,
  relativePath: string,
  body: string,
): WrittenPage {
  if (typeof body !== 'string') throw new Error('문서 본문이 string이 아닙니다')
  if (body.length > MAX_PAGE_BODY_CHARS) {
    throw new Error('문서 본문이 너무 깁니다 — 저장하지 않았습니다')
  }
  const normalized = assertSyncPagePath(relativePath)
  const absPath = join(workspaceRoot, normalized)
  if (!isWithinRoot(workspaceRoot, absPath) || !existsSync(absPath)) {
    throw new Error(`페이지 파일을 찾을 수 없습니다: ${normalized}`)
  }

  const { meta } = parsePageFile(readFileSync(absPath, 'utf8'))
  // 캐리어 무결성 위반 시 markdownToStorage가 throw한다(저장 거부)
  markdownToStorage(body)

  const next = renderPageFile(meta, body)
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, next, 'utf8')
  renameSync(tmpPath, absPath)

  return {
    pageId: meta.pageId,
    title: meta.title,
    url: meta.url,
    version: meta.version,
    markdown: body,
  }
}
