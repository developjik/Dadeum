import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import type { ModifiedPage } from '../../../core/push/changeSet'
import { useAppStore } from '../state/appStore'
import { DiffView } from './DiffView'
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

/** 그룹(수정·신규·첨부) 헤더 — 클릭 시 해당 그룹 전체를 선택/해제한다. */
function GroupLabel({
  paths,
  selected,
  onToggle,
  children,
}: {
  paths: string[]
  selected: Set<string>
  onToggle: (paths: string[]) => void
  children: React.ReactNode
}): React.ReactElement {
  const allChecked = paths.length > 0 && paths.every((path) => selected.has(path))
  return (
    <label className="changeset-group__label">
      <input
        type="checkbox"
        checked={allChecked}
        disabled={paths.length === 0}
        onChange={() => onToggle(paths)}
      />
      {children}
    </label>
  )
}

export function ReviewPanel({ spaceKey }: { spaceKey: string }): React.ReactElement {
  const loadChangeset = useAppStore((s) => s.loadChangeset)
  const approveUpload = useAppStore((s) => s.approveUpload)
  const openDiff = useAppStore((s) => s.openDiff)
  const diffs = useAppStore((s) => s.diffs)
  const changeset = useAppStore((s) => s.changeset)
  const pushOutcome = useAppStore((s) => s.pushOutcome)
  const reviewRunning = useAppStore((s) => s.reviewRunning)
  const reviewVerdict = useAppStore((s) => s.reviewVerdict)
  const reviewNote = useAppStore((s) => s.reviewNote)
  const busy = useAppStore((s) => s.busy)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  /** 펼쳐진 diff — 같은 버튼으로 다시 닫을 수 있다 */
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set())

  const toggle = (path: string): void => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  /** 그룹(수정·신규·첨부) 단위 일괄 선택/해제 */
  const toggleGroup = (paths: string[]): void => {
    setSelected((prev) => {
      const allSelected = paths.every((path) => prev.has(path))
      const next = new Set(prev)
      for (const path of paths) {
        if (allSelected) next.delete(path)
        else next.add(path)
      }
      return next
    })
  }

  const toggleDiff = (path: string): void => {
    if (openDiffs.has(path)) {
      setOpenDiffs((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      return
    }
    setOpenDiffs((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
    void openDiff(path)
  }

  const total = changeset
    ? changeset.modified.length + changeset.added.length + changeset.attachments.length
    : 0
  const missingCount = changeset?.missing.length ?? 0

  // changeset 경로에 없는 선택(자동 재검사로 사라진 항목)은 표시·승인에서 제외한다
  // — 죽은 경로가 push:approve 전체를 ENOENT로 실패시키지 않게 한다.
  const changesetPaths = new Set(
    changeset
      ? [
          ...changeset.modified.map((page) => page.path),
          ...changeset.added.map((page) => page.path),
          ...changeset.attachments.map((file) => file.path),
        ]
      : [],
  )
  const validSelected = new Set([...selected].filter((path) => changesetPaths.has(path)))

  // 감사 게이트: '승인 보류 권고(error)' 판정을 받은 파일이 승인 선택에 포함되면
  // 확인 단계의 문구를 위험 변형으로 바꾸고 대상 파일을 나열해 반드시 눈에 띄게 한다.
  const errorVerdictFiles = (reviewVerdict?.files ?? []).filter(
    (file) => file.status === 'error' && validSelected.has(file.path),
  )

  // 전체 선택/해제 — 현재 변경 세트의 선택 가능한 모든 경로
  const allPaths = changeset
    ? [
        ...changeset.modified.map((page) => page.path),
        ...changeset.added.map((page) => page.path),
        ...changeset.attachments.map((file) => file.path),
      ]
    : []
  const allSelected = allPaths.length > 0 && allPaths.every((path) => validSelected.has(path))

  return (
    <section className="review-pane" aria-label={ko.aria.uploadReview}>
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
          disabled={busy || allPaths.length === 0}
          onClick={() => setSelected(allSelected ? new Set() : new Set(allPaths))}
        >
          {allSelected ? ko.review.deselectAll : ko.review.selectAll}
        </button>
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
      {!changeset ? (
        <p className="review-pane__hint">
          <span className="spinner spinner--xs" aria-hidden="true" />
          {ko.app.loading}
        </p>
      ) : null}

      {reviewRunning || reviewVerdict || reviewNote ? (
        <section className="audit-card" aria-label={ko.review.auditTitle}>
          <header className="audit-card__head">
            {reviewRunning ? (
              <span className="spinner spinner--xs" aria-hidden="true" />
            ) : reviewVerdict ? (
              <CheckCircleIcon size={14} />
            ) : (
              <AlertIcon size={14} />
            )}
            <span className="audit-card__title">{ko.review.auditTitle}</span>
            {reviewRunning ? (
              <span className="audit-card__state">{ko.review.auditRunning}</span>
            ) : null}
          </header>
          {reviewVerdict ? (
            <div className="audit-card__body">
              {reviewVerdict.summary ? (
                <p className="audit-card__summary">{reviewVerdict.summary}</p>
              ) : null}
              <ul className="audit-card__files">
                {reviewVerdict.files.map((file) => (
                  <li key={file.path} className={`audit-file audit-file--${file.status}`}>
                    <span className="audit-file__status">
                      {file.status === 'ok'
                        ? ko.review.auditOk
                        : file.status === 'warn'
                          ? ko.review.auditWarn
                          : ko.review.auditError}
                    </span>
                    <span className="audit-file__path">{file.path}</span>
                    {file.note ? <span className="audit-file__note">{file.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : reviewNote ? (
            <p className="audit-card__note" role={reviewRunning ? 'status' : 'alert'}>
              {reviewNote}
            </p>
          ) : null}
        </section>
      ) : null}

      {changeset && (total > 0 || missingCount > 0) ? (
        <>
          {changeset.modified.length > 0 ? (
            <div className="changeset-group">
              <GroupLabel
                paths={changeset.modified.map((page) => page.path)}
                selected={validSelected}
                onToggle={toggleGroup}
              >
                {ko.review.modified}
              </GroupLabel>
              <ul className="cs-list">
                {changeset.modified.map((page: ModifiedPage) => (
                  <li key={page.path} className="cs-item">
                    <CheckItem
                      path={page.path}
                      checked={validSelected.has(page.path)}
                      onToggle={() => toggle(page.path)}
                    >
                      <span className="cs-item__path" title={page.path}>
                        {page.path}
                      </span>
                      <button
                        type="button"
                        className={`btn btn--default${openDiffs.has(page.path) ? ' btn--tinted' : ''}`}
                        aria-expanded={openDiffs.has(page.path)}
                        onClick={() => toggleDiff(page.path)}
                      >
                        <DiffIcon />
                        {ko.review.diffLabel}
                      </button>
                    </CheckItem>
                    {openDiffs.has(page.path) && diffs[page.path] ? (
                      <DiffView changes={diffs[page.path]!} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {changeset.added.length > 0 ? (
            <div className="changeset-group">
              <GroupLabel
                paths={changeset.added.map((page) => page.path)}
                selected={validSelected}
                onToggle={toggleGroup}
              >
                {ko.review.added}
              </GroupLabel>
              <ul className="cs-list">
                {changeset.added.map((page) => (
                  <li key={page.path} className="cs-item">
                    <CheckItem
                      path={page.path}
                      checked={validSelected.has(page.path)}
                      onToggle={() => toggle(page.path)}
                    >
                      <span className="cs-item__label" title={page.title}>
                        {page.title}
                      </span>
                      <span className="cs-item__path" title={page.path}>
                        {page.path}
                      </span>
                      <span className="badge badge--success">{ko.review.added}</span>
                    </CheckItem>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {changeset.attachments.length > 0 ? (
            <div className="changeset-group">
              <GroupLabel
                paths={changeset.attachments.map((file) => file.path)}
                selected={validSelected}
                onToggle={toggleGroup}
              >
                {ko.review.attachments}
              </GroupLabel>
              <ul className="cs-list">
                {changeset.attachments.map((attachment) => (
                  <li key={attachment.path} className="cs-item">
                    <CheckItem
                      path={attachment.path}
                      checked={validSelected.has(attachment.path)}
                      onToggle={() => toggle(attachment.path)}
                    >
                      <span className="cs-item__label" title={attachment.fileName}>
                        {attachment.fileName}
                      </span>
                      <span className="cs-item__path" title={attachment.path}>
                        {attachment.path}
                      </span>
                      <span className="badge badge--neutral">{ko.review.attachments}</span>
                    </CheckItem>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {missingCount > 0 ? (
            <div className="changeset-group">
              <span className="changeset-group__label changeset-group__label--static">
                {ko.review.missing}
              </span>
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
            <span className="review-actions__hint">
              {ko.review.selectedCount(validSelected.size)}
            </span>
            {confirming ? (
              <fieldset className="review-actions__confirm" aria-label={ko.aria.confirmUpload}>
                <span className="review-actions__confirm-text">
                  {errorVerdictFiles.length > 0
                    ? ko.review.confirmUploadWithErrors(errorVerdictFiles.length)
                    : ko.review.confirmUpload(validSelected.size)}
                </span>
                {errorVerdictFiles.length > 0 ? (
                  <span className="review-actions__confirm-errors" role="alert">
                    {errorVerdictFiles.map((file) => file.path).join(', ')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false)
                    void (async () => {
                      await approveUpload(spaceKey, [...validSelected])
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
              </fieldset>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || validSelected.size === 0}
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
          {pushOutcome.skippedRemoteAttachments.map((item) => (
            <div key={item.path} className="outcome-row outcome-row--neutral">
              <AlertIcon size={14} />
              <span className="outcome-row__path">{item.fileName}</span>
              <span className="outcome-row__detail">{ko.review.skippedRemoteAttachment}</span>
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
