import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 테마 팔레트 대비 검증 — 디자인 원칙("모든 표면의 텍스트는 대비 4.5:1 이상")을
 * 모드(라이트/다크) × 강조색 전 조합에 대해 강제한다.
 *
 * global.css를 직접 파싱해 토큰 값을 계산한다. color-mix()/var()의 실제 사용 형태만
 * 지원하는 축소 해석기를 쓴다(토큰 값을 테스트에 이중 관리하지 않기 위함).
 * 순수 문자열/숫자 연산만 수행한다(프로세스 실행·네트워크 없음).
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../styles/global.css')
const css = readFileSync(cssPath, 'utf8')

/* ------------------------------ CSS 파싱 ------------------------------ */

/** 최상위 블록(selector, body) 목록 — 주석과 @블록(@media, @keyframes)은 제외. */
function parseBlocks(source: string): Array<{ selector: string; body: string }> {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: Array<{ selector: string; body: string }> = []
  let depth = 0
  let selector = ''
  let body = ''
  for (const char of stripped) {
    if (depth === 0) {
      if (char === '{') {
        depth = 1
        body = ''
      } else {
        selector += char
      }
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        blocks.push({ selector: selector.trim(), body })
        selector = ''
        continue
      }
    }
    body += char
  }
  return blocks.filter((block) => !block.selector.startsWith('@'))
}

function parseDeclarations(body: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const declaration of body.split(';')) {
    const at = declaration.indexOf(':')
    if (at < 0) continue
    const name = declaration.slice(0, at).trim()
    const value = declaration.slice(at + 1).trim()
    if (name.startsWith('--')) tokens.set(name, value)
  }
  return tokens
}

const blocks = parseBlocks(css)

function declarationsOf(matcher: (selector: string) => boolean): Map<string, string> {
  const merged = new Map<string, string>()
  for (const block of blocks) {
    if (matcher(block.selector))
      for (const [k, v] of parseDeclarations(block.body)) merged.set(k, v)
  }
  return merged
}

const lightTokens = declarationsOf((selector) => selector === ':root')
const darkOverrides = declarationsOf((selector) => selector === ':root[data-mode="dark"]')

const ACCENTS = ['blue', 'teal', 'violet', 'rose', 'green'] as const

/** biome 포맷터가 셀렉터 따옴표를 정규화하므로('와 " 혼용) 무관하게 매칭한다. */
function accentBlockOf(accent: string): { selector: string; body: string } | undefined {
  const pattern = new RegExp(`^\\[data-accent=(['"])${accent}\\1]$`)
  return blocks.find((candidate) => pattern.test(candidate.selector))
}

function accentTokens(accent: string): Map<string, string> {
  const block = accentBlockOf(accent)
  if (!block) throw new Error(`data-accent='${accent}' 블록이 global.css에 없다`)
  return parseDeclarations(block.body)
}

/* ------------------------------ 색 계산 ------------------------------ */

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function substituteVars(value: string, tokens: Map<string, string>): string {
  let out = value
  for (let round = 0; round < 8; round += 1) {
    const next = out.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const resolved = tokens.get(name)
      if (resolved === undefined) throw new Error(`unknown token ${name}`)
      return resolved
    })
    if (next === out) return out
    out = next
  }
  throw new Error(`token substitution did not settle: ${value}`)
}

function parseHex(text: string): Rgba | null {
  const hex = text.trim().match(/^#([\da-f]{3,8})$/i)
  if (!hex) return null
  const digits = hex[1]
  if (digits.length === 3) {
    const channels = digits.split('').map((d) => Number.parseInt(d + d, 16))
    return { r: channels[0], g: channels[1], b: channels[2], a: 1 }
  }
  if (digits.length === 6 || digits.length === 8) {
    const color = {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    }
    return color
  }
  return null
}

/** color-mix(in srgb, A p%, B) — 본 저장소 토큰이 쓰는 형태만 지원한다. */
function parseColorMix(value: string): Rgba | null {
  const mixed = value.trim().match(/^color-mix\(in srgb,\s*(.+?)\s*,\s*(.+)\)$/i)
  if (!mixed) return null
  const leftRaw = mixed[1].trim()
  const rightRaw = mixed[2].trim()
  const leftWithWeight = leftRaw.match(/^(.+?)\s+([\d.]+)%$/)
  const leftColor = parseColor(leftWithWeight ? leftWithWeight[1] : leftRaw)
  const leftWeight = leftWithWeight ? Number(leftWithWeight[2]) / 100 : 0.5
  const rightColor = parseColor(rightRaw)
  const rightWeight = 1 - leftWeight
  const wa = leftWeight * leftColor.a
  const wb = rightWeight * rightColor.a
  if (wa + wb === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (leftColor.r * wa + rightColor.r * wb) / (wa + wb),
    g: (leftColor.g * wa + rightColor.g * wb) / (wa + wb),
    b: (leftColor.b * wa + rightColor.b * wb) / (wa + wb),
    a: wa + wb,
  }
}

function parseColor(value: string): Rgba {
  const trimmed = value.trim()
  if (trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = parseHex(trimmed)
  if (hex) return hex
  const mixed = parseColorMix(trimmed)
  if (mixed) return mixed
  const rgba = trimmed.match(/^rgba?\(([^)]+)\)$/i)
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
  }
  throw new Error(`unsupported color: ${value}`)
}

function tokenColor(name: string, tokens: Map<string, string>): Rgba {
  const raw = tokens.get(name)
  if (raw === undefined) throw new Error(`missing token ${name}`)
  return parseColor(substituteVars(raw, tokens))
}

/** 반투명 색을 불투명 바탕 위에 합성한다. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  }
}

function luminance(color: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(fg: Rgba, bg: Rgba): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/* ------------------------------ 조합 생성 ------------------------------ */

function tokenSet(mode: 'light' | 'dark', accent: (typeof ACCENTS)[number]): Map<string, string> {
  const tokens = new Map(lightTokens)
  for (const [k, v] of accentTokens(accent)) tokens.set(k, v)
  if (mode === 'dark') for (const [k, v] of darkOverrides) tokens.set(k, v)
  return tokens
}

/** [전경 토큰, 배경 토큰, 최소 대비, 배경이 반투명일 때 합성할 바탕 토큰] */
const PAIRS: Array<[string, string, number, string?]> = [
  ['--c-text', '--c-bg-panel', 4.5],
  ['--c-text', '--c-bg-app', 4.5],
  ['--c-text-2', '--c-bg-panel', 4.5],
  ['--c-text-2', '--c-bg-subtle', 4.5],
  ['--c-text-3', '--c-bg-panel', 4.5],
  ['--c-accent', '--c-bg-panel', 4.5],
  ['--c-accent', '--c-bg-app', 4.5],
  ['--c-accent', '--c-accent-tint', 4.5],
  ['--c-on-accent', '--c-accent', 4.5],
  ['--c-on-danger', '--c-danger', 4.5],
  ['--c-success', '--c-success-bg', 4.5, '--c-bg-panel'],
  ['--c-success', '--c-success-bg', 4.5, '--c-bg-app'],
  ['--c-warning', '--c-warning-bg', 4.5, '--c-bg-panel'],
  ['--c-warning', '--c-warning-bg', 4.5, '--c-bg-app'],
  ['--c-danger', '--c-danger-bg', 4.5, '--c-bg-panel'],
  ['--c-danger', '--c-danger-bg', 4.5, '--c-bg-app'],
  ['--c-diff-add-text', '--c-diff-add-bg', 4.5, '--c-bg-panel'],
  ['--c-diff-del-text', '--c-diff-del-bg', 4.5, '--c-bg-panel'],
  ['--c-code-text', '--c-code-bg', 4.5],
  ['--c-ink-text', '--c-ink', 4.5],
  ['--c-ink-text-muted', '--c-ink', 4.5],
  ['--c-ink-text-strong', '--c-ink-selected', 4.5, '--c-ink'],
  // 장식용(스페이스 키 코드, 트리 토글 아이콘) — 비-텍스트 수준 3:1만 요구
  ['--c-ink-text-faint', '--c-ink', 3],
]

describe('테마 팔레트 WCAG 대비', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const accent of ACCENTS) {
      it(`${mode}/${accent}: 모든 텍스트 쌍이 기준 대비를 충족한다`, () => {
        const tokens = tokenSet(mode, accent)
        for (const [fgName, bgName, min, overName] of PAIRS) {
          const fg = tokenColor(fgName, tokens)
          let bg = tokenColor(bgName, tokens)
          if (overName) bg = over(bg, tokenColor(overName, tokens))
          const ratio = contrast(fg, bg)
          expect(
            ratio,
            `${mode}/${accent}: ${fgName} on ${bgName} = ${ratio.toFixed(2)} (필요 ${min}:1)`,
          ).toBeGreaterThanOrEqual(min)
        }
      })
    }
  }

  it('global.css가 강조색 블록을 모두 정의한다', () => {
    for (const accent of ACCENTS) {
      expect(accentBlockOf(accent), `data-accent='${accent}' 블록 없음`).toBeDefined()
    }
  })
})
