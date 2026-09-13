/**
 * 캐리어 규약의 순수 문자열 토큰·펜스 빌더(renderer import 가능 — node 의존 금지).
 * carriers.ts는 해시 계산에 node:crypto를 쓰므로, renderer 번들이 문자열·펜스
 * 조작만 필요할 때는 이 모듈에서 가져온다(단일 소스 — 값은 carriers.ts 규약과 같다).
 */
export const CARRIER_LANG = 'confluence-storage'
/** 인라인 승격 조각의 자리표시 토큰(문단 흐름 안에서 위치를 보존). */
export const INLINE_REF_PREFIX = '⟦confluence-ref:'
export const INLINE_REF_SUFFIX = '⟧'

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
