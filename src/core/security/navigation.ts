/**
 * 창 내 내비게이션 허용 여부를 판정한다(계획 §6-7 — 원격 유래 콘텐츠가 앱을 외부로 유도하는 것을 차단).
 * - file: 스킴(빌드된 renderer)은 항상 허용
 * - 개발 모드에서는 electron-vite dev 서버(localhost/127.0.0.1 http)만 허용
 * - 그 외(https 포함)는 전부 거부 — 외부 링크는 OS 브라우저로 여는 것이 원칙
 */
export interface NavigationPolicy {
  /** 개발 모드 여부(dev 서버 origin 허용) */
  dev?: boolean
}

export function isAllowedNavigation(url: string, policy: NavigationPolicy = {}): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:') return true
  if (policy.dev && parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  }
  return false
}
