/**
 * Confluence Cloud API 타입(계획 §6-3).
 * 모든 식별자는 문자열로 다룬다(2^53 초과 pageId 정밀도 손실 방지 — F-9).
 */
export interface ConfluenceSpace {
  id: string
  key: string
  name: string
}

export interface ConfluencePageSummary {
  id: string
  title: string
  version?: { number?: number | string }
}

/** v2 API 페이지네이션 봉투(_links.next 기반 커서). */
export interface Paginated<T> {
  results: T[]
  _links?: {
    next?: string
    base?: string
  }
}

export type ConfluenceErrorKind =
  | 'unauthorized' // 401 — 이메일/토큰 오류
  | 'forbidden' // 403
  | 'not_found' // 404 — 원격 삭제됨
  | 'rate_limited' // 429
  | 'network' // 연결 실패/DNS
  | 'server' // 5xx
  | 'unexpected'

export class ConfluenceApiError extends Error {
  readonly kind: ConfluenceErrorKind
  readonly status?: number
  readonly retryAfterMs?: number

  constructor(kind: ConfluenceErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message)
    this.name = 'ConfluenceApiError'
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}
