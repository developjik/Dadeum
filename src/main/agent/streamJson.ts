import type { AgentRunEvent } from '../../core/agent/types'

/**
 * Claude Code stream-json 한 줄 → AgentRunEvent 목록(관대한 파서).
 * 프로토콜 변경 위험(F-10)을 줄이도록 알 수 없는 라인은 조용히 무시한다.
 */
export function parseStreamJsonLine(line: string): AgentRunEvent[] {
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

  if (record.type === 'system' && record.subtype === 'init') {
    return typeof record.session_id === 'string'
      ? [{ type: 'started', sessionId: record.session_id } as AgentRunEvent]
      : []
  }
  if (record.type === 'assistant') {
    const message = record.message as
      | { content?: Array<{ type?: string; text?: string; name?: string }> }
      | undefined
    const events: AgentRunEvent[] = []
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string')
        events.push({ type: 'text', value: block.text })
      if (block.type === 'tool_use' && typeof block.name === 'string')
        events.push({ type: 'tool', name: block.name })
    }
    return events
  }
  if (record.type === 'result') {
    return [] // 종단 상태는 프로세스 close가 담당
  }
  return []
}

export function parseStreamJsonLines(lines: string[]): AgentRunEvent[] {
  return lines.flatMap((line) => parseStreamJsonLine(line))
}
