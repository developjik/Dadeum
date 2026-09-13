import { contentHash } from './carriers'
import type { StorageToMarkdownResult } from './storageToMarkdownCore'
import { nodesToMarkdown } from './storageToMarkdownCore'
import { parseStorageFragment } from './xml'

/**
 * storage(XML) → Markdown 정방향 변환(main 프로세스용 공개 API).
 * 변환 핵심은 node 의존 없는 storageToMarkdownCore.ts에 있고, 이 래퍼는
 * 캐리어 무결성 해시(sha256 — markdownToStorage 검증과 짝)를 주입한다.
 */
export type { StorageToMarkdownResult } from './storageToMarkdownCore'

export function storageToMarkdown(storageXml: string): StorageToMarkdownResult {
  return nodesToMarkdown(parseStorageFragment(storageXml), contentHash)
}
