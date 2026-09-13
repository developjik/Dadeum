import { markdown } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { useMemo, useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { carrierLock } from '../editor/carrierLock'
import { type SelectedPage, useAppStore } from '../state/appStore'

/**
 * 직접 편집 패널 — 미리보기의 '직접 편집'에서 진입한다.
 * 본문(마크다운)만 편집하며 frontmatter는 다루지 않는다(main이 보존 관리).
 * 캐리어 펜스는 carrierLock 확장이 잠근다(carrierLock.ts 참조).
 */
export function EditorPane({ page }: { page: SelectedPage }): React.ReactElement | null {
  const editing = useAppStore((s) => s.editing)
  const setEditBody = useAppStore((s) => s.setEditBody)
  const saveEdit = useAppStore((s) => s.saveEdit)
  const cancelEdit = useAppStore((s) => s.cancelEdit)
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  // zustand 액션은 안정 참조 — 확장은 한 번만 만들어 재구성 깜빡임을 막는다
  const extensions = useMemo(
    () => [
      markdown(),
      ...carrierLock(),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            void saveEdit()
            return true
          },
        },
      ]),
    ],
    [saveEdit],
  )

  if (!editing || editing.path !== page.path) return null

  const saving = editing.saving
  const dirty = editing.body !== editing.baseline

  const requestCancel = (): void => {
    // 저장 안 된 변경이 있으면 인라인 확인을 거친다(앱의 확인 패턴 준수)
    if (dirty) {
      setConfirmingCancel(true)
      return
    }
    cancelEdit()
  }

  return (
    <section className="editor-pane" aria-label={ko.aria.pageEditor}>
      <header className="editor-pane__header">
        {saving ? <span className="spinner" aria-hidden="true" /> : null}
        <h1 className="editor-pane__title">{page.title}</h1>
        <span className="badge badge--accent">{ko.editor.editingBadge}</span>
        {dirty ? <span className="badge badge--neutral">{ko.editor.dirtyBadge}</span> : null}
        {confirmingCancel ? (
          <span className="editor-pane__confirm" role="alert">
            <span className="editor-pane__confirm-text">{ko.editor.cancelConfirm}</span>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setConfirmingCancel(false)
                cancelEdit()
              }}
            >
              {ko.editor.cancelConfirmYes}
            </button>
            <button
              type="button"
              className="btn btn--subtle"
              onClick={() => setConfirmingCancel(false)}
            >
              {ko.editor.cancelConfirmNo}
            </button>
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || saving}
          title={ko.editor.save}
          onClick={() => {
            setConfirmingCancel(false)
            void saveEdit()
          }}
        >
          {saving ? ko.editor.saving : ko.editor.save}
        </button>
        <button
          type="button"
          className="btn btn--default"
          disabled={saving}
          onClick={requestCancel}
        >
          {ko.editor.cancelEdit}
        </button>
      </header>
      <p className="editor-pane__hint">{ko.editor.carrierHint}</p>
      <div className="editor-body">
        <CodeMirror
          value={editing.body}
          height="100%"
          theme="none"
          extensions={extensions}
          onChange={setEditBody}
          aria-label={ko.aria.pageEditor}
        />
      </div>
    </section>
  )
}
