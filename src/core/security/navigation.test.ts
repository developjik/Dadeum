import { describe, expect, it } from 'vitest'
import { isAllowedNavigation } from './navigation'

describe('isAllowedNavigation', () => {
  it('file: 스킴은 지정된 renderer 경로 안에서만 허용한다', () => {
    expect(
      isAllowedNavigation('file:///app/out/renderer/index.html', {
        allowedFilePathPrefix: '/app/out/renderer',
      }),
    ).toBe(true)
    // 접두사 미지정·경로 이탈·구분자 우회('/app-x')는 전부 거부
    expect(isAllowedNavigation('file:///app/out/renderer/index.html')).toBe(false)
    expect(
      isAllowedNavigation('file:///app/secrets/keys', {
        allowedFilePathPrefix: '/app/out/renderer',
      }),
    ).toBe(false)
    expect(
      isAllowedNavigation('file:///app-x/escape.html', { allowedFilePathPrefix: '/app' }),
    ).toBe(false)
  })

  it('Windows 형식(백슬래시 접두사·드라이브 문자 선행 슬래시)도 정규화해 비교한다', () => {
    // main은 node:fs(join) 결과인 'C:\…' 백슬래시 접두사를 전달하고,
    // URL pathname은 '/C:/…' 형태로 온다 — 정규화 없으면 항상 불일치했다.
    expect(
      isAllowedNavigation('file:///C:/app/out/renderer/index.html', {
        allowedFilePathPrefix: 'C:\\app\\out\\renderer',
      }),
    ).toBe(true)
    expect(
      isAllowedNavigation('file:///C:/app/secrets/keys', {
        allowedFilePathPrefix: 'C:\\app\\out\\renderer',
      }),
    ).toBe(false)
    // 드라이브 문자만 바꾼 우회(C: → D:)도 거부
    expect(
      isAllowedNavigation('file:///D:/app/out/renderer/index.html', {
        allowedFilePathPrefix: 'C:\\app\\out\\renderer',
      }),
    ).toBe(false)
  })

  it('개발 모드에서 localhost http만 허용한다', () => {
    expect(isAllowedNavigation('http://localhost:5173/', { dev: true })).toBe(true)
    expect(isAllowedNavigation('http://127.0.0.1:5173/src/main.tsx', { dev: true })).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173/')).toBe(false)
  })

  it('외부 https는 개발 모드여도 거부한다', () => {
    expect(isAllowedNavigation('https://evil.example.com/', { dev: true })).toBe(false)
    expect(isAllowedNavigation('https://xxx.atlassian.net/wiki/')).toBe(false)
  })

  it('파서가 실패하는 문자열은 거부한다', () => {
    expect(isAllowedNavigation('not a url')).toBe(false)
    expect(isAllowedNavigation('')).toBe(false)
  })
})
