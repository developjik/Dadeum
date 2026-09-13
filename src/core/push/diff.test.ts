import { describe, expect, it } from 'vitest'
import { markdownLineDiff, summarizeChanges } from './diff'

describe('markdownLineDiff', () => {
  it('추가·삭제·불변 라인을 구분한다', () => {
    const changes = markdownLineDiff('a\nb\nc\n', 'a\nX\nc\nd\n')
    const summary = summarizeChanges(changes)
    expect(summary.addedLines).toBeGreaterThanOrEqual(2) // X, d
    expect(summary.removedLines).toBeGreaterThanOrEqual(1) // b
    expect(changes.some((change) => change.type === 'unchanged')).toBe(true)
  })

  it('동일 텍스트는 변경이 없다', () => {
    expect(summarizeChanges(markdownLineDiff('same\n', 'same\n'))).toEqual({
      addedLines: 0,
      removedLines: 0,
    })
  })
})
