/**
 * 테마 시스템 — 빌트인(모드 × 강조색) + VS Code 테마 적용.
 *
 * 강조색 추가 절차:
 * 1. styles/global.css에 [data-accent='<id>'] 원색 스케일 블록 + 스와치 점 클래스 추가
 * 2. AccentId 유니언과 themes/contrast.test.ts의 강조색 목록에 추가
 * 3. core/i18n/ko.ts settings 문안, SettingsDialog 항목에 추가
 *
 * VS Code 테마는 core/theme/vscode.ts가 토큰 전체 집합으로 매핑하며, 이 모듈이
 * documentElement에 인라인으로 주입한다(인라인 선언이 스타일시트 토큰을 이긴다).
 * 적용 중에는 data-mode만 테마 자체 값으로 바꾸고, 해제 시 빌트인 설정을 복원한다.
 * 설정값은 localStorage에 저장된다(UI 기본 설정 — main 프로세스 관여 없음).
 */

import type { MappedTheme, ThemeMode as MappedThemeMode } from '../../../core/theme/vscode'

export type ThemeMode = 'system' | 'light' | 'dark'
export type AccentId = 'blue' | 'teal' | 'violet' | 'rose' | 'green'

/** 저장·적용 대상이 되는 테마(VS Code 팔레트 매핑 결과) */
interface CustomTheme {
  id: string
  name: string
  mode: MappedThemeMode
  tokens: Record<string, string>
  contrastIssues: string[]
}

const ACCENT_IDS: readonly AccentId[] = ['blue', 'teal', 'violet', 'rose', 'green']

const MODE_KEY = 'theme.mode'
const ACCENT_KEY = 'theme.accent'
const CUSTOMS_KEY = 'theme.customs'
const CUSTOM_ACTIVE_KEY = 'theme.customActive'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

let mode: ThemeMode = 'system'
let accent: AccentId = 'blue'

function resolveMode(value: ThemeMode): 'light' | 'dark' {
  if (value !== 'system') return value
  return darkQuery.matches ? 'dark' : 'light'
}

function apply(): void {
  document.documentElement.dataset.mode = resolveMode(mode)
  document.documentElement.dataset.accent = accent
}

export function getMode(): ThemeMode {
  return mode
}

export function getAccent(): AccentId {
  return accent
}

export function setMode(next: ThemeMode): void {
  mode = next
  localStorage.setItem(MODE_KEY, next)
  apply()
}

export function setAccent(next: AccentId): void {
  accent = next
  localStorage.setItem(ACCENT_KEY, next)
  apply()
}

/** React 렌더 전 1회 호출 — 저장된 설정을 DOM에 먼저 반영해 테마 깜빡임을 막는다. */
export function initTheme(): void {
  const savedMode = localStorage.getItem(MODE_KEY)
  if (savedMode === 'light' || savedMode === 'dark' || savedMode === 'system') mode = savedMode
  const savedAccent = localStorage.getItem(ACCENT_KEY)
  if (savedAccent !== null && ACCENT_IDS.includes(savedAccent as AccentId)) {
    accent = savedAccent as AccentId
  }
  apply()
  // 시스템 모드에서 OS 외관 변경을 즉시 따라간다
  darkQuery.addEventListener('change', () => {
    if (mode === 'system') apply()
  })
  // 활성 커스텀 테마가 있으면 빌트인 위에 주입한다
  const active = getActiveCustomId()
  if (active) applyCustomTokens(readCustoms().find((custom) => custom.id === active) ?? null)
}

/* --------------------------- VS Code 커스텀 테마 --------------------------- */

let injectedTokenNames: string[] = []

function readCustoms(): CustomTheme[] {
  const raw = localStorage.getItem(CUSTOMS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is CustomTheme =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as CustomTheme).id === 'string' &&
        typeof (item as CustomTheme).name === 'string' &&
        typeof (item as CustomTheme).tokens === 'object',
    )
  } catch {
    return []
  }
}

function writeCustoms(customs: CustomTheme[]): void {
  localStorage.setItem(CUSTOMS_KEY, JSON.stringify(customs))
}

export function getActiveCustomId(): string | null {
  return localStorage.getItem(CUSTOM_ACTIVE_KEY)
}

function applyCustomTokens(custom: CustomTheme | null): void {
  const root = document.documentElement
  for (const name of injectedTokenNames) root.style.removeProperty(name)
  injectedTokenNames = []
  if (!custom) {
    // 빌트인 data-mode/data-accent 복원
    apply()
    return
  }
  for (const [name, value] of Object.entries(custom.tokens)) {
    root.style.setProperty(name, value)
    injectedTokenNames.push(name)
  }
  // 인라인 토큰과 어울리는 스크롤바/폼 color-scheme
  root.dataset.mode = custom.mode
}

/** 커스텀 테마 활성화(null이면 빌트인으로 복원). */
export function activateCustomTheme(id: string | null): void {
  if (id === null) {
    localStorage.removeItem(CUSTOM_ACTIVE_KEY)
    applyCustomTokens(null)
    return
  }
  const custom = readCustoms().find((item) => item.id === id)
  if (!custom) return
  localStorage.setItem(CUSTOM_ACTIVE_KEY, id)
  applyCustomTokens(custom)
}

/**
 * 테마 활성화. 저장소에 upsert한 뒤 즉시 주입한다 — 프리셋도 함께 저장해
 * 재시작 복원 경로를 하나로 유지한다.
 */
export function activateTheme(mapped: MappedTheme): void {
  const custom: CustomTheme = {
    id: mapped.id,
    name: mapped.name,
    mode: mapped.mode,
    tokens: mapped.tokens,
    contrastIssues: mapped.contrastIssues,
  }
  writeCustoms([...readCustoms().filter((item) => item.id !== custom.id), custom])
  activateCustomTheme(custom.id)
}

/** 활성 테마(커스텀)의 대비 경고 — 없으면 빈 배열. */
export function activeContrastIssues(): string[] {
  const id = getActiveCustomId()
  if (!id) return []
  return readCustoms().find((item) => item.id === id)?.contrastIssues ?? []
}
