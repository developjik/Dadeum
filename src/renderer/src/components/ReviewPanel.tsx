import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import type { ModifiedPage } from '../../../core/push/changeSet'
import type { LineChange } from '../../../core/push/diff'
import { useAppStore } from '../state/appStore'

export function ReviewPanel({ spaceKey }: { spaceKey: string }): React.ReactElement {
  const loadChangeset = useAppStore((s) => s.loadChangeset)
  const approveUpload = useAppStore((s) => s.approveUpload)
  const openDiff = useAppStore((s) => s.openDiff)
  const diffs = useAppStore((s) => s.diffs)
  const changeset = useAppStore((s) => s.changeset)
  const pushOutcome = useAppStore((s) => s.pushOutcome)
  const busy = useAppStore((s) => s.busy)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (path: string): void => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  return (
    <section aria-label="upload-review">
      <h2>{ko.review.diffTitle}</h2>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setSelected(new Set())
          void loadChangeset(spaceKey)
        }}
      >
        {ko.review.reviewUpload}
      </button>

      {changeset ? (
        <>
          {changeset.modified.length === 0 && changeset.added.length === 0 ? <p>{ko.review.empty}</p> : null}
          <ul>
            {changeset.modified.map((page: ModifiedPage) => (
              <li key={page.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(page.path)}
                    onChange={() => toggle(page.path)}
                  />
                  {page.path}
                </label>
                <button type="button" onClick={() => void openDiff(page.path)}>
                  {ko.review.diffLabel}
                </button>
                {diffs[page.path] ? <DiffView changes={diffs[page.path]!} /> : null}
              </li>
            ))}
            {changeset.attachments.map((attachment) => (
              <li key={attachment.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(attachment.path)}
                    onChange={() => toggle(attachment.path)}
                  />
                  {ko.review.attachmentPrefix} {attachment.fileName} ({attachment.path})
                </label>
              </li>
            ))}
            {changeset.added.map((page) => (
              <li key={page.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(page.path)}
                    onChange={() => toggle(page.path)}
                  />
                  {ko.review.addedPrefix} {page.title} ({page.path})
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void approveUpload(spaceKey, [...selected])}
          >
            {ko.review.approve}
          </button>

        </>
      ) : null}

      {pushOutcome ? (
        <div>
          {pushOutcome.uploaded.map((item) => (
            <p key={item.path}>
              {ko.review.uploaded}: {item.path} (v{item.newVersion})
            </p>
          ))}
          {pushOutcome.conflicts.map((item) => (
            <p key={item.path} role="alert">
              {ko.review.conflictNotice}: {item.path}
            </p>
          ))}
          {pushOutcome.remoteDeleted.map((item) => (
            <p key={item.path} role="alert">
              {ko.review.remoteDeletedNotice}: {item.path}
            </p>
          ))}
          {pushOutcome.failed.map((item) => (
            <p key={item.path} role="alert">
              {ko.review.failedNotice}: {item.path} — {item.error}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function DiffView({ changes }: { changes: LineChange[] }): React.ReactElement {
  return (
    <pre className="diff-view">
      {changes.flatMap((change) =>
        change.value
          .split('\n')
          .filter((line: string) => line.length > 0)
          .map((line: string, index: number) => (
            <div key={index} className={`diff-${change.type}`}>
              {change.type === 'added' ? '+ ' : change.type === 'removed' ? '- ' : '  '}
              {line}
            </div>
          ))
      )}
    </pre>
  )
}
