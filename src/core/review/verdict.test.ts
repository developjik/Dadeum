import { describe, expect, it } from 'vitest'
import { parseReviewVerdict } from './verdict'

const VALID_JSON =
  '{"files":[{"path":"spaces/DEV/a/index.md","status":"ok"},{"path":"spaces/DEV/b/index.md","status":"warn","note":"제목 변경이 지시와 무관"}],"summary":"전반적으로 양호"}'

describe('parseReviewVerdict', () => {
  it('코드펜스로 감싼 JSON 판정을 파싱한다', () => {
    const verdict = parseReviewVerdict(
      `감사를 마쳤습니다.\n\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n\n이상입니다.`,
    )
    expect(verdict).not.toBeNull()
    expect(verdict?.files).toHaveLength(2)
    expect(verdict?.files[1]?.status).toBe('warn')
    expect(verdict?.files[1]?.note).toContain('무관')
    expect(verdict?.summary).toContain('양호')
  })

  it('펜스 없는 순수 JSON도 파싱한다', () => {
    const verdict = parseReviewVerdict(VALID_JSON)
    expect(verdict?.files[0]?.path).toBe('spaces/DEV/a/index.md')
  })

  it('문자열 내 중괄호를 값으로 갖는 JSON을 오해하지 않는다', () => {
    const verdict = parseReviewVerdict(
      '{"files":[{"path":"a/index.md","status":"error","note":"note {깨진} 표기"}]}',
    )
    expect(verdict?.files[0]?.note).toBe('note {깨진} 표기')
  })

  it('불가능한 status·빈 path 항목은 걸러낸다', () => {
    const verdict = parseReviewVerdict(
      '{"files":[{"path":"a/index.md","status":"catastrophe"},{"path":"","status":"ok"},{"path":"b/index.md","status":"ok"}]}',
    )
    expect(verdict?.files).toHaveLength(1)
    expect(verdict?.files[0]?.path).toBe('b/index.md')
  })

  it('JSON이 아니거나 판정이 비면 null을 반환한다(위조 금지)', () => {
    expect(parseReviewVerdict('모든 파일이 적합해 보입니다.')).toBeNull()
    expect(parseReviewVerdict('')).toBeNull()
    expect(parseReviewVerdict('{"files":[]}')).toBeNull()
    expect(parseReviewVerdict('{"files":"전부 괜찮음"}')).toBeNull()
  })
})
