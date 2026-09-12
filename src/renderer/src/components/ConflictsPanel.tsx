import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'

export function ConflictsPanel({ spaceKey }: { spaceKey: string }): React.ReactElement {
  const loadConflicts = useAppStore((s) => s.loadConflicts)
  const resolveConflict = useAppStore((s) => s.resolveConflict)
  const conflicts = useAppStore((s) => s.conflicts)
  const busy = useAppStore((s) => s.busy)
  const [open, setOpen] = useState(false)

  return (
    <section aria-label="conflicts">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setOpen(true)
          void loadConflicts(spaceKey)
        }}
      >
        {ko.conflict.list}
      </button>
      {open ? (
        conflicts.length === 0 ? (
          <p>{ko.conflict.none}</p>
        ) : (
          <ul>
            {conflicts.map((candidate) => (
              <li key={candidate.pageId}>
                {candidate.path} — {candidate.reason === 'remote-deleted' ? ko.sync.remoteDeleted : ko.conflict.localChanges}
                <button type="button" disabled={busy} onClick={() => void resolveConflict(candidate, 'overwrite')}>
                  {ko.conflict.overwrite}
                </button>
                <span className="warn">{ko.conflict.overwriteWarning}</span>
                <button type="button" disabled={busy} onClick={() => void resolveConflict(candidate, 'take-remote')}>
                  {ko.conflict.takeRemote}
                </button>
                <button type="button" disabled={busy} onClick={() => void resolveConflict(candidate, 'manual')}>
                  {ko.conflict.manualMerge}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}
