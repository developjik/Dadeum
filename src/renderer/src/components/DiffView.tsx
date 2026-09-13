import type { LineChange } from '../../../core/push/diff'

/** 라인 diff 렌더 — 검토 패널과 충돌 패널이 공유한다. */
export function DiffView({ changes }: { changes: LineChange[] }): React.ReactElement {
  return (
    <pre className="diff-view">
      {changes.flatMap((change, changeIndex) =>
        change.value
          .split('\n')
          .filter((line: string) => line.length > 0)
          .map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff 줄에는 안정적 식별자가 없고 changeIndex 조합으로 형제 간 키 충돌을 막는다
            <div key={`${changeIndex}-${index}`} className={`diff-line diff-line--${change.type}`}>
              {change.type === 'added' ? '+ ' : change.type === 'removed' ? '- ' : '  '}
              {line}
            </div>
          )),
      )}
    </pre>
  )
}
