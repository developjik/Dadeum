import { useEffect, useRef, useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { presetThemes } from '../../../core/theme/presets'
import {
  type AccentId,
  activateCustomTheme,
  activateTheme,
  activeContrastIssues,
  getAccent,
  getActiveCustomId,
  getMode,
  setAccent,
  setMode,
  type ThemeMode,
} from '../themes/theme'
import { AlertIcon, CloseIcon } from './icons'

const MODE_ITEMS: Array<{ id: ThemeMode; label: string }> = [
  { id: 'system', label: ko.settings.modeSystem },
  { id: 'light', label: ko.settings.modeLight },
  { id: 'dark', label: ko.settings.modeDark },
]

const ACCENT_ITEMS: Array<{ id: AccentId; swatch: string; label: string }> = [
  { id: 'blue', swatch: 'blue', label: ko.settings.accentBlue },
  { id: 'teal', swatch: 'teal', label: ko.settings.accentTeal },
  { id: 'violet', swatch: 'violet', label: ko.settings.accentViolet },
  { id: 'rose', swatch: 'rose', label: ko.settings.accentRose },
  { id: 'green', swatch: 'green', label: ko.settings.accentGreen },
]

/**
 * 설정 모달 — 확장 가능한 섹션 셸(현재는 테마 섹션만).
 * Esc·배경 클릭으로 닫히고, 포커스는 다이얼로그 안에서 순환한다.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [mode, setModeState] = useState<ThemeMode>(getMode())
  const [accent, setAccentState] = useState<AccentId>(getAccent())
  const [activeCustomId, setActiveCustomId] = useState<string | null>(getActiveCustomId())
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const contrastIssues = activeContrastIssues()

  const pickBuiltIn = (): void => {
    // 모드·강조색 선택은 테마 칩 선택을 해제하는 복귀 동작을 겸한다
    activateCustomTheme(null)
    setActiveCustomId(null)
  }

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => restoreFocusRef.current?.focus()
  }, [])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    // 간단 포커스 트랩 — Tab/Shift+Tab이 다이얼로그 안에서 순환한다
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const active = document.activeElement
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 배경 클릭으로 닫기는 모달의 표준 패턴이다(대화형 요소는 내부 dialog)
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ko.settings.title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="settings-dialog__head">
          <h2 className="settings-dialog__title">{ko.settings.title}</h2>
          <button
            type="button"
            className="btn btn--subtle"
            aria-label={ko.common.close}
            onClick={onClose}
          >
            <CloseIcon size={14} />
            {ko.common.close}
          </button>
        </header>

        <section className="settings-section" aria-label={ko.settings.theme}>
          <span className="settings-section__title">{ko.settings.theme}</span>

          <span className="settings-section__title settings-section__field">
            {ko.settings.themeMode}
          </span>
          <fieldset className="seg" aria-label={ko.settings.themeMode}>
            {MODE_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="seg__btn"
                aria-pressed={mode === item.id && activeCustomId === null}
                onClick={() => {
                  pickBuiltIn()
                  setMode(item.id)
                  setModeState(item.id)
                }}
              >
                {item.label}
              </button>
            ))}
          </fieldset>

          <span className="settings-section__title settings-section__field">
            {ko.settings.themeAccent}
          </span>
          <fieldset className="swatch-grid" aria-label={ko.settings.themeAccent}>
            {ACCENT_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="swatch"
                aria-pressed={accent === item.id && activeCustomId === null}
                onClick={() => {
                  pickBuiltIn()
                  setAccent(item.id)
                  setAccentState(item.id)
                }}
              >
                <span className={`swatch__dot swatch__dot--${item.swatch}`} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </fieldset>

          <span className="settings-section__title settings-section__field">
            {ko.settings.vscode}
          </span>
          <p className="settings-hint">{ko.settings.vscodeHint}</p>
          <fieldset className="swatch-grid" aria-label={ko.settings.vscode}>
            {presetThemes().map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="swatch"
                aria-pressed={activeCustomId === preset.id}
                onClick={() => {
                  activateTheme(preset)
                  setActiveCustomId(preset.id)
                }}
              >
                <span
                  className="swatch__dot"
                  style={{ background: preset.tokens['--c-accent'] }}
                  aria-hidden="true"
                />
                {preset.name}
              </button>
            ))}
          </fieldset>

          {activeCustomId !== null && contrastIssues.length > 0 ? (
            <p className="settings-warning">
              <AlertIcon size={13} />
              {ko.settings.contrastWarning}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}
