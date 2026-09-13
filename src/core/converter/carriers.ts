import { createHash } from 'node:crypto'
import type { ParsedCarrier } from './carrierTokens'

/**
 * 펜스드 캐리어 규약(계획 §7 — F-1 개정).
 * Markdown으로 표현할 수 없는 storage 조각은 CommonMark 펜스드 코드블록으로
 * 운반한다. info string에 매크로 이름과 콘텐츠 해시 id를 싣고, 본문은
 * 원본 storage XML을 verbatim 보존한다. push 시 해시로 무결성을 재확인하고
 * 펜스 내용을 그대로 storage에 재주입한다.
 *
 * node:crypto를 쓰는 해시만 이 모듈에 남고(renderer import 불가),
 * 순수 문자열 조작은 carrierTokens.ts로 옮겼다(renderer-no-node 규칙).
 */
export {
  CARRIER_LANG,
  carrierFence,
  INLINE_REF_PREFIX,
  INLINE_REF_SUFFIX,
  type ParsedCarrier,
} from './carrierTokens'

export function contentHash(serializedXml: string): string {
  return createHash('sha256').update(serializedXml, 'utf8').digest('hex').slice(0, 8)
}

/** 펜스 내용의 해시가 info string의 id와 일치하는지 검증(무결성). */
export function verifyCarrierIntegrity(carrier: ParsedCarrier): boolean {
  return contentHash(carrier.content) === carrier.id
}
