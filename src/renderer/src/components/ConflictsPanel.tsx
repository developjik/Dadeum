import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'
import { DiffView } from './DiffView'
import { AlertIcon } from './icons'

export function ConflictsPanel({ spaceKey }: { spaceKey: string }): React.ReactElement {
  const loadConflicts = useAppStore((s) => s.loadConflicts)
  const resolveConflict = useAppStore((s) => s.resolveConflict)
  const openDiff = useAppStore((s) => s.openDiff)
  const conflicts = useAppStore((s) => s.conflicts)
  const diffs = useAppStore((s) => s.diffs)
  const busy = useAppStore((s) => s.busy)
  // 위험 동작(덮어쓰기)은 2단계 확인 — 확인 대상 pageId를 저장한다
  const [confirmingOverwrite, setConfirmingOverwrite] = useState<string | null>(null)

  return (
    <section className="conflict-pane" aria-label={ko.aria.conflicts}>
      <div className="conflict-pane__title">
        <AlertIcon size={16} />
        {ko.conflict.list}
        {conflicts.length > 0 ? (
          <span className="badge badge--warning">
            {ko.sync.conflictCandidates(conflicts.length)}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn--default"
          disabled={busy}
          style={{ marginLeft: 'auto' }}
          onClick={() => void loadConflicts(spaceKey)}
        >
          {ko.review.recheck}
        </button>
      </div>
      {conflicts.length === 0 ? (
        <p className="tree__empty">{ko.conflict.none}</p>
      ) : (
        <ul className="conflict-list">
          {conflicts.map((candidate) => {
            const isRemoteDeleted = candidate.reason === 'remote-deleted'
            const confirming = confirmingOverwrite === candidate.pageId
            return (
              <li key={candidate.pageId} className="conflict-card">
                <div className="conflict-card__head">
                  <span className="conflict-card__path">{candidate.path}</span>
                  <span className={`badge ${isRemoteDeleted ? 'badge--danger' : 'badge--warning'}`}>
                    {isRemoteDeleted ? ko.sync.remoteDeleted : ko.conflict.localChanges}
                  </span>
                </div>
                {isRemoteDeleted ? (
                  <p className="conflict-card__warning">{ko.conflict.remoteDeletedHint}</p>
                ) : (
                  <>
                    <p className="conflict-card__warning">
                      <strong>{ko.conflict.overwriteWarning}</strong>
                    </p>
                    <div className="conflict-card__actions">
                      {confirming ? (
                        <>
                          <span className="conflict-card__confirm" role="alert">
                            {ko.conflict.overwriteConfirm}
                          </span>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={busy}
                            onClick={() => {
                              setConfirmingOverwrite(null)
                              void resolveConflict(candidate, 'overwrite')
                            }}
                          >
                            {ko.conflict.overwriteConfirmYes}
                          </button>
                          <button
                            type="button"
                            className="btn btn--subtle"
                            disabled={busy}
                            onClick={() => setConfirmingOverwrite(null)}
                          >
                            {ko.common.cancel}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={busy}
                            onClick={() => setConfirmingOverwrite(candidate.pageId)}
                          >
                            {ko.conflict.overwrite}
                          </button>
                          <button
                            type="button"
                            className="btn btn--default"
                            disabled={busy}
                            title={ko.conflict.keepBothHint}
                            onClick={() => void resolveConflict(candidate, 'keep-both')}
                          >
                            {ko.conflict.keepBoth}
                          </button>
                          <button
                            type="button"
                            className="btn btn--default"
                            disabled={busy}
                            onClick={() => void resolveConflict(candidate, 'take-remote')}
                          >
                            {ko.conflict.takeRemote}
                          </button>
                          <button
                            type="button"
                            className="btn btn--subtle"
                            disabled={busy}
                            onClick={() => {
                              void openDiff(candidate.path)
                              void resolveConflict(candidate, 'manual')
                            }}
                          >
                            {ko.conflict.manualMerge}
                          </button>
                        </>
                      )}
                    </div>
                    {/* 직접 처리 선택 시 로컬↔원격 차이를 카드 바로 아래에 보여준다 —
                        예전에는 diff를 불러만 두고 화면 어디에도 렌더하지 않았다 */}
                    {diffs[candidate.path] ? (
                      <div className="conflict-card__diff">
                        <p className="conflict-card__warning">{ko.conflict.manualMergeHint}</p>
                        <span className="section-label">{ko.conflict.diffLabel}</span>
                        <DiffView changes={diffs[candidate.path]!} />
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
