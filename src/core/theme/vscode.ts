import {
  compositeOver,
  contrastRatio,
  formatRgba,
  mixColors,
  parseCssColor,
  parseHexColor,
  type Rgba,
  readableOn,
  shiftLuminance,
} from './color'

/**
 * VS Code 색 테마(JSON) → 본 앱 디자인 토큰 매핑.
 *
 * VS Code 테마는 IDE 생태계의 사실상 표준 형식이다(colors + tokenColors). 우리 앱은
 * 에디터가 아니므로 450여 개 키 중 문서 뷰어 표면에 대응하는 핵심 키만 읽고,
 * 나머지 토큰은 배경/전경/강조에서 유도 규칙으로 채운다. tokenColors(문법 강조)는
 * 코드 하이라이팅 도입 시 쓰기 위해 일단 보류한다.
 *
 * 매핑 결과는 components가 참조하는 토큰 전체 집합이며, 렌더러가
 * documentElement에 인라인으로 주입해 빌트인 테마를 대체한다.
 */

export type ThemeMode = 'light' | 'dark'

export interface MappedTheme {
  id: string
  name: string
  mode: ThemeMode
  /** 디자인 토큰 전체 집합(--c-* 이름 → CSS 색 값) */
  tokens: Record<string, string>
  /** 4.5:1 미달 쌍 목록(가독 경고 표시용 — 가져오기를 막지는 않는다) */
  contrastIssues: string[]
}

interface VscodeThemeJson {
  name?: unknown
  type?: unknown
  colors?: unknown
  tokenColors?: unknown
}

export function isVscodeThemeJson(raw: unknown): raw is VscodeThemeJson {
  if (typeof raw !== 'object' || raw === null) return false
  const candidate = raw as VscodeThemeJson
  if (
    candidate.type !== 'dark' &&
    candidate.type !== 'light' &&
    typeof candidate.type !== 'string'
  ) {
    return false
  }
  return typeof candidate.colors === 'object' && candidate.colors !== null
}

const DARK_TYPES = new Set(['dark', 'hcblack'])

type ColorTable = Record<string, string>

function pickColor(table: ColorTable, keys: string[]): Rgba | null {
  for (const key of keys) {
    const value = table[key]
    if (typeof value === 'string') {
      const parsed = parseHexColor(value)
      if (parsed) return parsed
    }
  }
  return null
}

/** 텍스트/상태 색이 반투명하면 바탕 위에 합성해 불투명하게 만든다. */
function opaque(color: Rgba, background: Rgba): Rgba {
  return color.a >= 1 ? color : compositeOver(color, background)
}

/** 유도 텍스트가 바탕 대비 4.5:1에 못 미치면 읽기 좋아질 때까지 밝기 방향으로 민다. */
function ensureReadable(fg: Rgba, bg: Rgba, mode: ThemeMode): Rgba {
  let color = fg
  const target: Rgba =
    mode === 'light' ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
  for (let step = 0; step < 10 && contrastRatio(color, bg) < 4.5; step += 1) {
    color = mixColors(color, target, 0.12)
  }
  return color
}

const CONTRAST_PAIRS: Array<{ fg: string; bg: string; label: string }> = [
  { fg: '--c-text', bg: '--c-bg-panel', label: '본문 텍스트' },
  { fg: '--c-text-2', bg: '--c-bg-panel', label: '보조 텍스트' },
  { fg: '--c-accent', bg: '--c-bg-panel', label: '강조 텍스트' },
  { fg: '--c-on-accent', bg: '--c-accent', label: '버튼 텍스트' },
  { fg: '--c-ink-text', bg: '--c-ink', label: '사이드바 텍스트' },
  { fg: '--c-diff-add-text', bg: '--c-diff-add-bg', label: 'diff 추가' },
  { fg: '--c-diff-del-text', bg: '--c-diff-del-bg', label: 'diff 삭제' },
]

export function mapVscodeTheme(raw: unknown, id: string): MappedTheme {
  if (!isVscodeThemeJson(raw)) throw new Error('not a vscode theme json')
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : 'dark'
  const mode: ThemeMode = DARK_TYPES.has(type) ? 'dark' : 'light'
  const towardLight = mode === 'dark' // 어두운 모드에서는 백색 쪽으로 시프트해 계층을 만든다
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id
  const colors = (raw.colors ?? {}) as ColorTable

  // ---- 핵심 표면 ----
  const bgPanel =
    pickColor(colors, ['editor.background']) ??
    (mode === 'dark' ? { r: 23, g: 31, b: 44, a: 1 } : { r: 255, g: 255, b: 255, a: 1 })
  const text = opaque(
    pickColor(colors, ['editor.foreground']) ??
      (mode === 'dark' ? { r: 221, g: 228, b: 240, a: 1 } : { r: 23, g: 38, b: 63, a: 1 }),
    bgPanel,
  )
  const bgApp = opaque(
    pickColor(colors, ['editorGroupHeader.noTabsBackground', 'editorGroupHeader.tabsBackground']) ??
      shiftLuminance(bgPanel, towardLight, 0.04),
    bgPanel,
  )
  const ink = opaque(
    pickColor(colors, ['sideBar.background', 'activityBar.background']) ??
      shiftLuminance(bgApp, towardLight, 0.05),
    bgPanel,
  )
  const inkText = opaque(
    pickColor(colors, ['sideBar.foreground', 'activityBar.foreground']) ?? text,
    bgPanel,
  )
  const text2 = opaque(
    pickColor(colors, ['descriptionForeground']) ?? mixColors(text, bgPanel, 0.28),
    bgPanel,
  )
  const text3 = opaque(
    pickColor(colors, ['input.placeholderForeground']) ?? mixColors(text, bgPanel, 0.48),
    bgPanel,
  )
  const border =
    pickColor(colors, ['editorGroup.border', 'panel.border', 'contrastBorder']) ??
    mixColors(bgPanel, text, 0.14)
  const borderStrong = pickColor(colors, ['contrastBorder']) ?? mixColors(border, text, 0.3)

  // ---- 강조 ----
  const accent =
    pickColor(colors, ['button.background', 'focusBorder', 'statusBar.background']) ??
    (mode === 'dark' ? { r: 110, g: 168, b: 255, a: 1 } : { r: 12, g: 102, b: 228, a: 1 })
  const accentHover =
    pickColor(colors, ['button.hoverBackground']) ?? shiftLuminance(accent, towardLight, 0.12)
  const buttonForeground = pickColor(colors, ['button.foreground'])
  const onAccent = buttonForeground ? opaque(buttonForeground, accent) : readableOn(accent)
  const accentTint = mixColors(bgPanel, accent, 0.1)
  const accentTintHover = mixColors(bgPanel, accent, 0.16)
  const accentSoft = { ...accent, a: 0.18 }

  // ---- 상태 ----
  const success = opaque(
    pickColor(colors, ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground']) ??
      (mode === 'dark' ? { r: 87, g: 201, b: 147, a: 1 } : { r: 26, g: 122, b: 74, a: 1 }),
    bgPanel,
  )
  const warning = opaque(
    pickColor(colors, ['terminal.ansiYellow', 'gitDecoration.modifiedResourceForeground']) ??
      (mode === 'dark' ? { r: 229, g: 184, b: 92, a: 1 } : { r: 138, g: 91, b: 0, a: 1 }),
    bgPanel,
  )
  const danger = opaque(
    pickColor(colors, ['terminal.ansiRed', 'gitDecoration.deletedResourceForeground']) ??
      (mode === 'dark' ? { r: 242, g: 131, b: 111, a: 1 } : { r: 201, g: 55, b: 44, a: 1 }),
    bgPanel,
  )
  const onDanger = readableOn(danger)
  const diffAddBg = opaque(
    pickColor(colors, [
      'diffEditor.insertedTextBackground',
      'diffEditor.insertedLineBackground',
    ]) ?? { ...success, a: 0.16 },
    bgPanel,
  )
  const diffDelBg = opaque(
    pickColor(colors, ['diffEditor.removedTextBackground', 'diffEditor.removedLineBackground']) ?? {
      ...danger,
      a: 0.16,
    },
    bgPanel,
  )
  const diffAddText = ensureReadable(
    opaque(pickColor(colors, ['gitDecoration.addedResourceForeground']) ?? success, bgPanel),
    diffAddBg,
    mode,
  )
  const diffDelText = ensureReadable(
    opaque(pickColor(colors, ['gitDecoration.deletedResourceForeground']) ?? danger, bgPanel),
    diffDelBg,
    mode,
  )

  // ---- 코드 블록/사이드바 파생 ----
  const codeBg = opaque(
    pickColor(colors, ['textCodeBlock.background', 'editorWidget.background']) ??
      shiftLuminance(bgPanel, towardLight, 0.08),
    bgPanel,
  )
  const bgDiff = opaque(
    pickColor(colors, ['diffEditor.background']) ?? mixColors(bgPanel, text, 0.03),
    bgPanel,
  )
  const inkSelected = { ...accent, a: 0.3 }
  const inkHover = { ...inkText, a: 0.09 }

  const tokens: Record<string, string> = {
    '--c-text': formatRgba(text),
    '--c-text-2': formatRgba(text2),
    '--c-text-3': formatRgba(text3),
    '--c-border': formatRgba(border),
    '--c-border-strong': formatRgba(borderStrong),
    '--c-bg-app': formatRgba(bgApp),
    '--c-bg-panel': formatRgba(bgPanel),
    '--c-bg-hover': formatRgba({ ...text, a: 0.06 }),
    '--c-bg-subtle': formatRgba(mixColors(bgPanel, text, 0.045)),
    '--c-accent': formatRgba(accent),
    '--c-accent-hover': formatRgba(accentHover),
    '--c-accent-tint': formatRgba(accentTint),
    '--c-accent-tint-hover': formatRgba(accentTintHover),
    '--c-accent-soft': formatRgba(accentSoft),
    '--c-on-accent': formatRgba(onAccent),
    '--c-ink': formatRgba(ink),
    '--c-ink-2': formatRgba(mixColors(ink, inkText, 0.08)),
    '--c-ink-hover': formatRgba(inkHover),
    '--c-ink-text': formatRgba(inkText),
    '--c-ink-text-muted': formatRgba(mixColors(inkText, ink, 0.45)),
    '--c-ink-text-faint': formatRgba(mixColors(inkText, ink, 0.62)),
    '--c-ink-text-hover': formatRgba(mixColors(inkText, { r: 255, g: 255, b: 255, a: 1 }, 0.4)),
    '--c-ink-text-strong': '#ffffff',
    '--c-ink-accent': formatRgba(mixColors(accent, { r: 255, g: 255, b: 255, a: 1 }, 0.45)),
    '--c-ink-accent-bg': formatRgba(accentSoft),
    '--c-ink-selected': formatRgba(inkSelected),
    '--c-ink-line': formatRgba({ ...inkText, a: 0.14 }),
    '--c-success': formatRgba(success),
    '--c-success-bg': formatRgba({ ...success, a: 0.13 }),
    '--c-success-border': formatRgba({ ...success, a: 0.38 }),
    '--c-warning': formatRgba(warning),
    '--c-warning-bg': formatRgba({ ...warning, a: 0.13 }),
    '--c-warning-border': formatRgba({ ...warning, a: 0.38 }),
    '--c-danger': formatRgba(danger),
    '--c-danger-hover': formatRgba(shiftLuminance(danger, towardLight, 0.12)),
    '--c-danger-bg': formatRgba({ ...danger, a: 0.12 }),
    '--c-danger-bg-strong': formatRgba({ ...danger, a: 0.22 }),
    '--c-danger-border': formatRgba({ ...danger, a: 0.4 }),
    '--c-on-danger': formatRgba(onDanger),
    '--c-diff-add-bg': formatRgba(diffAddBg),
    '--c-diff-add-text': formatRgba(diffAddText),
    '--c-diff-del-bg': formatRgba(diffDelBg),
    '--c-diff-del-text': formatRgba(diffDelText),
    '--c-code-bg': formatRgba(codeBg),
    '--c-code-border': formatRgba(mixColors(codeBg, text, 0.14)),
    '--c-code-text': formatRgba(opaque(pickColor(colors, ['editor.foreground']) ?? text, codeBg)),
    '--c-bg-diff': formatRgba(bgDiff),
  }

  const contrastIssues = CONTRAST_PAIRS.filter(({ fg, bg }) => {
    const fgColor = parseCssColor(tokens[fg])
    const bgColor = parseCssColor(tokens[bg])
    if (!fgColor || !bgColor) return false
    return contrastRatio(fgColor, bgColor) < 4.5
  }).map(({ label }) => label)

  return { id, name, mode, tokens, contrastIssues }
}
