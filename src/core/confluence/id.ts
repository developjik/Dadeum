/**
 * Confluence 식별자 정규화(F-9): API가 숫자로 반환하더라도 문자열로 강제한다.
 * JS Number는 2^53을 넘는 pageId에서 정밀도를 잃으므로, 숫자 입력 자체가
 * 이미 손실됐을 수 있다 — 따라서 문자열 우선, 숫자는 String() 변환만 허용.
 */
export function normalizeId(id: unknown): string {
  if (typeof id === 'string') return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  if (typeof id === 'bigint') return id.toString()
  throw new Error(`식별자는 문자열이어야 합니다: ${JSON.stringify(id)}`)
}
