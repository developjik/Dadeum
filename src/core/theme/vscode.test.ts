import { describe, expect, it } from 'vitest'
import { contrastRatio, parseCssColor } from './color'
import { PRESET_THEME_JSONS, presetThemes } from './presets'
import { isVscodeThemeJson, mapVscodeTheme } from './vscode'

describe('VS Code 테마 매핑', () => {
  it('형식 검증 — colors와 type이 있는 객체만 받는다', () => {
    expect(isVscodeThemeJson({ type: 'dark', colors: {} })).toBe(true)
    expect(isVscodeThemeJson({ type: 'light', colors: { 'editor.background': '#fff' } })).toBe(true)
    expect(isVscodeThemeJson({ colors: {} })).toBe(false)
    expect(isVscodeThemeJson(null)).toBe(false)
    expect(isVscodeThemeJson({ type: 'dark' })).toBe(false)
  })

  it('무효 입력은 오류를 던진다', () => {
    expect(() => mapVscodeTheme('dracula', 't1')).toThrow()
    expect(() => mapVscodeTheme({ type: 'dark' }, 't1')).toThrow()
  })

  it('hclight 같은 변형 타입도 라이트/다크로 분류한다', () => {
    expect(mapVscodeTheme({ type: 'hcBlack', colors: {} }, 't1').mode).toBe('dark')
    expect(mapVscodeTheme({ type: 'hcLight', colors: {} }, 't1').mode).toBe('light')
  })

  it('키 매핑 — editor/sideBar/button/terminal 키가 토큰으로 온다', () => {
    const theme = mapVscodeTheme(
      {
        name: 'Fixture Dark',
        type: 'dark',
        colors: {
          'editor.background': '#1e1e2e',
          'editor.foreground': '#cdd6f4',
          'sideBar.background': '#181825',
          'button.background': '#89b4fa',
          'button.foreground': '#1e1e2e',
          'terminal.ansiGreen': '#a6e3a1',
          'terminal.ansiRed': '#f38ba8',
          'gitDecoration.addedResourceForeground': '#a6e3a1',
        },
      },
      'fixture',
    )
    expect(theme.name).toBe('Fixture Dark')
    expect(theme.mode).toBe('dark')
    expect(theme.tokens['--c-bg-panel']).toBe('rgba(30, 30, 46, 1)')
    expect(theme.tokens['--c-ink']).toBe('rgba(24, 24, 37, 1)')
    expect(theme.tokens['--c-accent']).toBe('rgba(137, 180, 250, 1)')
    expect(theme.tokens['--c-on-accent']).toBe('rgba(30, 30, 46, 1)')
    expect(theme.tokens['--c-success']).toBe('rgba(166, 227, 161, 1)')
    expect(theme.tokens['--c-diff-add-text']).toBe('rgba(166, 227, 161, 1)')
    // 유도 토큰도 함께 채워진다 — 컴포넌트가 참조하는 전체 집합
    expect(theme.tokens['--c-text-2']).toMatch(/^rgba\(/)
    expect(theme.tokens['--c-accent-tint']).toMatch(/^rgba\(/)
    expect(Object.keys(theme.tokens).length).toBeGreaterThanOrEqual(40)
  })

  it('필수 키가 없으면 기본 팔레트로 폴백한다', () => {
    const theme = mapVscodeTheme({ name: 'Bare', type: 'light', colors: {} }, 'bare')
    expect(theme.tokens['--c-bg-panel']).toBe('rgba(255, 255, 255, 1)')
    expect(theme.tokens['--c-ink']).toMatch(/^rgba\(/)
    expect(theme.contrastIssues).toEqual([])
  })

  it('저대비 테마는 경고를 남기되 막지는 않는다', () => {
    const theme = mapVscodeTheme(
      {
        name: 'Low Contrast',
        type: 'light',
        colors: { 'editor.background': '#ffffff', 'editor.foreground': '#aaaaaa' },
      },
      'low',
    )
    expect(theme.contrastIssues).toContain('본문 텍스트')
  })

  describe('내장 프리셋', () => {
    it('모두 매핑에 성공하고 본문 대비 4.5:1을 충족한다', () => {
      expect(presetThemes().length).toBe(PRESET_THEME_JSONS.length)
      for (const theme of presetThemes()) {
        const text = parseCssColor(theme.tokens['--c-text'])
        const panel = parseCssColor(theme.tokens['--c-bg-panel'])
        if (!text || !panel) throw new Error(`${theme.id}: 텍스트/배경 토큰 파싱 실패`)
        expect(contrastRatio(text, panel), `${theme.id} 본문 대비`).toBeGreaterThanOrEqual(4.5)
      }
    })
  })
})
