import { createHash } from 'node:crypto'

/**
 * 펜스드 캐리어 규약(계획 §7 — F-1 개정).
 * Markdown으로 표현할 수 없는 storage 조각은 CommonMark 펜스드 코드블록으로
 * 운반한다. info string에 매크로 이름과 콘텐츠 해시 id를 싣고, 본문은
 * 원본 storage XML을 verbatim 보존한다. push 시 해시로 무결성을 재확인하고
 * 펜스 내용을 그대로 storage에 재주입한다.
 */
export const CARRIER_LANG = 'confluence-storage'
/** 인라인 승격 조각의 자리표시 토큰(문단 흐름 안에서 위치를 보존). */
export const INLINE_REF_PREFIX = '⟦confluence-ref:'
export const INLINE_REF_SUFFIX = '⟧'

export function contentHash(serializedXml: string): string {
  return createHash('sha256').update(serializedXml, 'utf8').digest('hex').slice(0, 8)
}

/** 내용의 최대 백틱 런보다 긴 펜스를 만든다(내부 ``` 라인 조기 종료 방지). */
export function fenceFor(content: string): string {
  let maxRun = 0
  for (const run of content.match(/`+/g) ?? []) maxRun = Math.max(maxRun, run.length)
  return '`'.repeat(Math.max(3, maxRun + 1))
}

export function carrierFence(name: string, hashId: string, serializedXml: string): string {
  const fence = fenceFor(serializedXml)
  return [`${fence}${CARRIER_LANG} name=${name} id=${hashId}`, serializedXml, fence].join('\n')
}

export function inlineRefToken(hashId: string): string {
  return `${INLINE_REF_PREFIX}${hashId}${INLINE_REF_SUFFIX}`
}

export interface ParsedCarrier {
  name: string
  id: string
  content: string
}

/** 펜스 내용의 해시가 info string의 id와 일치하는지 검증(무결성). */
export function verifyCarrierIntegrity(carrier: ParsedCarrier): boolean {
  return contentHash(carrier.content) === carrier.id
}
