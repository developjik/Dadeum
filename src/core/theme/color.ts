/**
 * 색상 계산 유틸 — VS Code 테마 매핑(vscode.ts)에서 공유하는 순수 함수 모음.
 * sRGB 기준의 단순 혼합·합성·대비 계산만 다룬다.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** #RGB / #RRGGBB / #RRGGBBAA 지원(VS Code 색 표기). */
export function parseHexColor(input: string): Rgba | null {
  const hex = input.trim().match(/^#([\da-f]{3,8})$/i)
  if (!hex) return null
  const digits = hex[1]
  if (digits.length === 3) {
    const channels = digits.split('').map((d) => Number.parseInt(d + d, 16))
    return { r: channels[0], g: channels[1], b: channels[2], a: 1 }
  }
  if (digits.length !== 6 && digits.length !== 8) return null
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
    a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
  }
}

/** hex와 rgb()/rgba() 문자열을 모두 읽는다(formatRgba 출력 재파싱용). */
export function parseCssColor(input: string): Rgba | null {
  const hex = parseHexColor(input)
  if (hex) return hex
  const rgba = input.trim().match(/^rgba?\(([^)]+)\)$/i)
  if (!rgba) return null
  const parts = rgba[1].split(',').map((part) => Number(part.trim()))
  if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
}

export function formatRgba(color: Rgba): string {
  const channel = (value: number): number => Math.round(Math.min(255, Math.max(0, value)))
  const alpha = Math.round(Math.min(1, Math.max(0, color.a)) * 1000) / 1000
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${alpha})`
}

export function mixColors(a: Rgba, b: Rgba, weightOfB: number): Rgba {
  const t = Math.min(1, Math.max(0, weightOfB))
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  }
}

/** 전경을 바탕 위에 알파 합성한다(바탕이 불투명하면 결과도 불투명). */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  }
}

function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/** 배경에서 읽기 좋은 전경색(흰/검)을 고른다 — 강조 표면 위 버튼 텍스트 등. */
export function readableOn(background: Rgba): Rgba {
  return relativeLuminance(background) > 0.35
    ? { r: 16, g: 21, b: 31, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 }
}

/** 밝기 방향 시프트 — dark에서는 흰 쪽, light에서는 검 쪽으로 밀 때 쓴다. */
export function shiftLuminance(color: Rgba, towardLight: boolean, amount: number): Rgba {
  const target: Rgba = towardLight ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }
  return mixColors(color, target, amount)
}
