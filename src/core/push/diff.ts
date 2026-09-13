import { diffLines } from 'diff'

/** 한 파일의 라인 단위 변경(diff 패키지 jsdiff 위임 — 검증된 구현). */
export interface LineChange {
  type: 'added' | 'removed' | 'unchanged'
  value: string
}

export function markdownLineDiff(oldText: string, newText: string): LineChange[] {
  return diffLines(oldText, newText).map((change) => ({
    type: change.added ? 'added' : change.removed ? 'removed' : 'unchanged',
    value: change.value,
  }))
}

/** diff 요약(UI 배지용): 추가/삭제 라인 수. */
export function summarizeChanges(changes: LineChange[]): {
  addedLines: number
  removedLines: number
} {
  let addedLines = 0
  let removedLines = 0
  for (const change of changes) {
    const lines = change.value.split('\n').length - (change.value.endsWith('\n') ? 1 : 0)
    if (change.type === 'added') addedLines += lines
    if (change.type === 'removed') removedLines += lines
  }
  return { addedLines, removedLines }
}
