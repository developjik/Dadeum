import { fileHashOf } from './hash'
import { parsePageFile } from './workspace'

/**
 * 페이지 콘텐츠 지문(동기화 정확성 보강 — 가짜 diff 제거):
 * dirty 판정·변경 세트는 '의미 있는 편집'(제목·본문)만 잡아야 한다.
 * 앱이 관리하는 frontmatter 필드(version·syncedAt) 갱신이나 개행 표기(CRLF·EOF
 * 개행 수) 차이는 변경이 아니다 — 편집기·서버 재직렬화가 만드는 표기 노이즈다.
 */

/** 마크다운 본문의 정규형: LF 개행, EOF 개행 1회. 의미를 바꾸지 않는 표기만 흡수한다. */
export function canonicalMarkdownBody(body: string): string {
  return `${body.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`
}

/** 페이지 파일 전체에서 동기 의미가 있는 부분(제목·본문)만 정규화해 해시한다. */
export function pageContentHashOf(rawFileContent: string): string {
  const { meta, body } = parsePageFile(rawFileContent)
  return fileHashOf(`${meta.title}\n\n${canonicalMarkdownBody(body)}`)
}

/**
 * 저장된 content_hash와의 unchanged 판정.
 * v3 정규화 해시와 v2까지의 전체-파일 바이트 해시를 모두 수용한다 —
 * 업그레이드 직후 기존 워크스페이스 전체가 dirty로 오판되는 것을 막는다.
 * (레거시 행은 다음 전체 pull에서 새 해시로 수렴한다.)
 * frontmatter가 깨진 파일은 파싱 불가 = 변경된 것으로 본다(보호 우선).
 */
export function pageHashMatches(rawFileContent: string, storedHash: string | null): boolean {
  if (storedHash === null) return false
  if (fileHashOf(rawFileContent) === storedHash) return true
  try {
    return pageContentHashOf(rawFileContent) === storedHash
  } catch {
    return false
  }
}
