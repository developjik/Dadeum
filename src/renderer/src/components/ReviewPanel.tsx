import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import type { ModifiedPage } from '../../../core/push/changeSet'
import type { LineChange } from '../../../core/push/diff'
import { useAppStore } from '../state/appStore'
import { AlertIcon, CheckCircleIcon, DiffIcon } from './icons'

function CheckItem({
  path,
  checked,
  onToggle,
  children,
}: {
  path: string
  checked: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="cs-item__row">
      <label className="cs-item__check">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={path} />
      </label>
      {children}
    </div>
  )
}

export function ReviewPanel({ spaceKey }: { spaceKey: string }): React.ReactElement {
  const loadChangeset = useAppStore((s) => s.loadChangeset)
  const approveUpload = useAppStore((s) => s.approveUpload)
  const openDiff = useAppStore((s) => s.openDiff)
  const diffs = useAppStore((s) => s.diffs)
  const changeset = useAppStore((s) => s.changeset)
  const pushOutcome = useAppStore((s) => s.pushOutcome)
  const busy = useAppStore((s) => s.busy)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)

  const toggle = (path: string): void => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  const total = changeset
    ? changeset.modified.length + changeset.added.length + changeset.attachments.length
    : 0
  const missingCount = changeset?.missing.length ?? 0

  return (
    <section className="review-pane" aria-label="upload-review">
      <div className="review-pane__toolbar">
        <div className="review-pane__summary">
          {changeset ? (
            <>
              {changeset.modified.length > 0 ? (
                <span className="badge badge--accent">
                  {ko.review.modifiedCount(changeset.modified.length)}
                </span>
              ) : null}
              {changeset.added.length > 0 ? (
                <span className="badge badge--success">
                  {ko.review.addedCount(changeset.added.length)}
                </span>
              ) : null}
              {changeset.attachments.length > 0 ? (
                <span className="badge badge--neutral">
                  {ko.review.attachmentCount(changeset.attachments.length)}
                </span>
              ) : null}
              {missingCount > 0 ? (
                <span className="badge badge--danger">{ko.review.missingCount(missingCount)}</span>
              ) : null}
              {total === 0 && missingCount === 0 ? (
                <span className="badge badge--neutral">{ko.review.empty}</span>
              ) : null}
            </>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--default"
          disabled={busy}
          onClick={() => {
            setSelected(new Set())
            void loadChangeset(spaceKey)
          }}
        >
          {ko.review.recheck}
        </button>
      </div>
      {!changeset ? <p className="review-pane__hint">{ko.app.loading}</p> : null}

      {changeset && (total > 0 || missingCount > 0) ? (
        <>
          {changeset.modified.length > 0 ? (
            <div className="changeset-group">
              <span className="changeset-group__label">{ko.review.modified}</span>
              <ul className="cs-list">
                {changeset.modified.map((page: ModifiedPage) => (
                  <li key={page.path} className="cs-item">
                    <CheckItem
                      path={page.path}
                      checked={selected.has(page.path)}
                      onToggle={() => toggle(page.path)}
                    >
                      <span className="cs-item__path">{page.path}</span>
                      <button
                        type="button"
                        className="btn btn--default"
                        onClick={() => void openDiff(page.path)}
                      >
                        <DiffIcon />
                        {ko.review.diffLabel}
                      </button>
                    </CheckItem>
                    {diffs[page.path] ? <DiffView changes={diffs[page.path]!} /> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {changeset.added.length > 0 ? (
            <div className="changeset-group">
              <span className="changeset-group__label">{ko.review.added}</span>
              <ul className="cs-list">
                {changeset.added.map((page) => (
                  <li key={page.path} className="cs-item">
                    <CheckItem
                      path={page.path}
                      checked={selected.has(page.path)}
                      onToggle={() => toggle(page.path)}
                    >
                      <span className="cs-item__label">{page.title}</span>
                      <span className="cs-item__path">{page.path}</span>
                      <span className="badge badge--success">{ko.review.added}</span>
                    </CheckItem>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {changeset.attachments.length > 0 ? (
            <div className="changeset-group">
              <span className="changeset-group__label">{ko.review.attachments}</span>
              <ul className="cs-list">
                {changeset.attachments.map((attachment) => (
                  <li key={attachment.path} className="cs-item">
                    <CheckItem
                      path={attachment.path}
                      checked={selected.has(attachment.path)}
                      onToggle={() => toggle(attachment.path)}
                    >
                      <span className="cs-item__label">{attachment.fileName}</span>
                      <span className="cs-item__path">{attachment.path}</span>
                      <span className="badge badge--neutral">{ko.review.attachments}</span>
                    </CheckItem>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {missingCount > 0 ? (
            <div className="changeset-group">
              <span className="changeset-group__label">{ko.review.missing}</span>
              <ul className="cs-list">
                {changeset.missing.map((page) => (
                  <li key={page.path} className="cs-item">
                    <div className="cs-item__row">
                      <span className="cs-item__label">{page.title}</span>
                      <span className="cs-item__path">{page.path}</span>
                      <span className="badge badge--danger">{ko.review.missing}</span>
                    </div>
                    <p className="cs-item__hint">{ko.review.missingHint}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="review-actions">
            <span className="review-actions__hint">{ko.review.selectedCount(selected.size)}</span>
            {confirming ? (
              <div
                className="review-actions__confirm"
                role="alertdialog"
                aria-label="confirm-upload"
              >
                <span className="review-actions__confirm-text">
                  {ko.review.confirmUpload(selected.size)}
                </span>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false)
                    void (async () => {
                      await approveUpload(spaceKey, [...selected])
                      setSelected(new Set())
                    })()
                  }}
                >
                  {ko.review.uploadConfirm}
                </button>
                <button
                  type="button"
                  className="btn btn--subtle"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  {ko.common.cancel}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || selected.size === 0}
                onClick={() => setConfirming(true)}
              >
                {ko.review.approve}
              </button>
            )}
          </div>
        </>
      ) : null}

      {pushOutcome ? (
        <div className="outcome-list">
          {pushOutcome.uploaded.map((item) => (
            <div key={item.path} className="outcome-row outcome-row--success">
              <CheckCircleIcon size={14} />
              <span className="outcome-row__path">{item.path}</span>
              <span className="outcome-row__detail">
                {ko.review.uploaded} · v{item.newVersion}
              </span>
            </div>
          ))}
          {pushOutcome.conflicts.map((item) => (
            <div key={item.path} className="outcome-row outcome-row--warning" role="alert">
              <AlertIcon size={14} />
              <span className="outcome-row__path">{item.path}</span>
              <span className="outcome-row__detail">{ko.review.conflictNotice}</span>
            </div>
          ))}
          {pushOutcome.remoteDeleted.map((item) => (
            <div key={item.path} className="outcome-row outcome-row--warning" role="alert">
              <AlertIcon size={14} />
              <span className="outcome-row__path">{item.path}</span>
              <span className="outcome-row__detail">{ko.review.remoteDeletedNotice}</span>
            </div>
          ))}
          {pushOutcome.deletedAttachments.map((item) => (
            <div key={item.path} className="outcome-row outcome-row--neutral">
              <AlertIcon size={14} />
              <span className="outcome-row__path">{item.fileName}</span>
              <span className="outcome-row__detail">{ko.review.deletedAttachment}</span>
            </div>
          ))}
          {pushOutcome.failed.map((item) => (
            <div key={item.path} className="outcome-row outcome-row--danger" role="alert">
              <AlertIcon size={14} />
              <span className="outcome-row__path">{item.path}</span>
              <span className="outcome-row__detail">
                {ko.review.failedNotice} · {item.error}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function DiffView({ changes }: { changes: LineChange[] }): React.ReactElement {
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
