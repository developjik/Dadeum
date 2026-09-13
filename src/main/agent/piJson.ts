import type { AgentRunEvent } from '../../core/agent/types'

/**
 * pi(--mode json) 한 줄 → AgentRunEvent 변환기(관대한 파서).
 * pi는 줄 상태(message_start/update/end)를 가지므로 파서도 상태를 갖는다:
 * - 텍스트는 message_update의 text_delta로 스트리밍하고, 델타를 못 받은
 *   (스트리밍 없는 프로바이더) 경우에만 message_end 스냅샷으로 대체 발행한다.
 * - 세션 id는 첫 줄 session 헤더의 id, 최종 응답은 agent_end 시점의 마지막 assistant 텍스트.
 * 알 수 없는 이벤트(queue_update·compaction 등)는 조용히 무시한다(F-10과 동일 기조).
 */
export class PiJsonParser {
  private deltaEmitted = false
  private lastAssistantText = ''

  feed(line: string): AgentRunEvent[] {
    const trimmed = line.trim()
    if (trimmed.length === 0) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return [] // 부분 라인/비 JSON 출력 무시
    }
    if (!parsed || typeof parsed !== 'object') return []
    const record = parsed as Record<string, unknown>

    if (record.type === 'session') {
      return typeof record.id === 'string' ? [{ type: 'started', sessionId: record.id }] : []
    }
    if (record.type === 'message_start') {
      this.deltaEmitted = false
      return []
    }
    if (record.type === 'message_update') {
      const event = record.assistantMessageEvent as { type?: string; delta?: unknown } | undefined
      if (
        event?.type === 'text_delta' &&
        typeof event.delta === 'string' &&
        event.delta.length > 0
      ) {
        this.deltaEmitted = true
        return [{ type: 'text', value: event.delta }]
      }
      return []
    }
    if (record.type === 'message_end') {
      const message = record.message as { role?: string; content?: unknown } | undefined
      if (message?.role && message.role !== 'assistant') return []
      const text = extractText(message?.content)
      if (typeof text === 'string' && text.length > 0) this.lastAssistantText = text
      // 델타를 이미 스트리밍했으면 스냅샷 재발행은 중복이다
      if (!this.deltaEmitted && text) return [{ type: 'text', value: text }]
      return []
    }
    if (record.type === 'tool_execution_start') {
      return typeof record.toolName === 'string' ? [{ type: 'tool', name: record.toolName }] : []
    }
    if (record.type === 'agent_end') {
      // agent_end에는 오류 필드가 없다 — 실행 실패 판정은 프로세스 close가 담당한다.
      return [{ type: 'result', isError: false, value: this.lastAssistantText || undefined }]
    }
    return []
  }

  /** 마지막 assistant 응답 전문(감사 판정 등 결과 소비용). */
  get finalText(): string {
    return this.lastAssistantText
  }
}

/** assistant content 블록에서 텍스트만 추출 — 배열(블록)과 문자열 양쪽을 받는다. */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('')
}
