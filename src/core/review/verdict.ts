/**
 * 변경 감사(리뷰 게이트) 판정 계약 — main이 프롬프트를 만들고 renderer가 결과를 그린다.
 * 감사 에이전트는 JSON만 출력하도록 지시받지만, LLM 출력은 신뢰할 수 없으므로
 * 파서는 관대하게(코드펜스/부가 설명 포용) 그리고 실패는 null로(위조 판정 금지).
 */

type VerdictStatus = 'ok' | 'warn' | 'error'
interface FileVerdict {
  path: string
  status: VerdictStatus
  /** 한 줄 사유(한글). */
  note?: string
}

export interface ReviewVerdict {
  files: FileVerdict[]
  summary?: string
}

const STATUS_VALUES: readonly VerdictStatus[] = ['ok', 'warn', 'error']

function coerceVerdict(parsed: unknown): ReviewVerdict | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = parsed as { files?: unknown; summary?: unknown }
  if (!Array.isArray(raw.files)) return null
  const files: FileVerdict[] = []
  for (const item of raw.files) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { path?: unknown; status?: unknown; note?: unknown }
    if (typeof entry.path !== 'string' || entry.path.length === 0) continue
    if (typeof entry.status !== 'string') continue
    if (!(STATUS_VALUES as readonly string[]).includes(entry.status)) continue
    files.push({
      path: entry.path,
      status: entry.status as VerdictStatus,
      note: typeof entry.note === 'string' && entry.note.length > 0 ? entry.note : undefined,
    })
  }
  if (files.length === 0) return null
  return {
    files,
    summary: typeof raw.summary === 'string' && raw.summary.length > 0 ? raw.summary : undefined,
  }
}

/** 텍스트에서 첫 JSON 객체를 추출(중괄호 균형 스캔 — 문자열 내 괄호 오오판 방지). */
function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 감사 출력 텍스트 → 판정. 코드펜스·전후 설명 포용, 파싱 실패·빈 판정은 null. */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  // 1) ```json ... ``` 펜스 우선 시도
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    const verdict = coerceVerdict(extractFirstJsonObject(fence[1]))
    if (verdict) return verdict
  }
  // 2) 펜스가 없거나 펜스 내용이 깨지면 본문 전체에서 탐색
  return coerceVerdict(extractFirstJsonObject(trimmed))
}
