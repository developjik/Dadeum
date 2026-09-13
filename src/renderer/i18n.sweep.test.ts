import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * AC-12 문안 단일 소스 검증(정적 스캔):
 * renderer UI 코드(src/renderer/src)에는 한글 리터럴이 직접 나타나지 않아야 한다 —
 * 모든 UI 문안은 core/i18n/ko.ts를 통해 제공된다(ef-16, ko.ts 단일 소스 원칙).
 * 주석은 UI 문안이 아니므로 제거한 뒤 검사한다.
 */
function collectFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      found.push(...collectFiles(abs))
      continue
    }
    if (/\.(tsx?|jsx?)$/.test(entry)) found.push(abs)
  }
  return found
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const HANGUL = /[\uac00-\ud7a3]/

describe('한국어 문안 단일 소스(AC-12 정적 검증)', () => {
  it('renderer/src UI 코드에 한글 리터럴이 없다(모두 ko.ts 경유)', () => {
    const dir = join(__dirname, 'src')
    const files = collectFiles(dir).filter((file) => !/\.test\.tsx?$/.test(file))
    expect(files.length).toBeGreaterThan(0)

    const offenders = files
      .map((file) => ({ file, lines: stripComments(readFileSync(file, 'utf8')).split('\n') }))
      .map(({ file, lines }) => ({
        file,
        hitLines: lines
          .map((line, index) => ({ line: index + 1, text: line }))
          .filter(({ text }: { text: string }) => HANGUL.test(text)),
      }))
      .filter(({ hitLines }) => hitLines.length > 0)

    expect(offenders).toEqual([])
  })
})
