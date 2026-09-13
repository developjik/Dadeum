/**
 * 창 내 내비게이션 허용 여부를 판정한다(계획 §6-7 — 원격 유래 콘텐츠가 앱을 외부로 유도하는 것을 차단).
 * - file: 스킴은 앱 renderer 경로 접두사로 한정 허용(미지정 시 거부)
 * - 개발 모드에서는 electron-vite dev 서버(localhost/127.0.0.1 http)만 허용
 * - 그 외(https 포함)는 전부 거부 — 외부 링크는 OS 브라우저로 여는 것이 원칙
 */
export interface NavigationPolicy {
  /** 개발 모드 여부(dev 서버 origin 허용) */
  dev?: boolean
  /** file: 허용 대상 디렉터리(빌드된 renderer 경로 — main이 전달) */
  allowedFilePathPrefix?: string
}

/** file: URL pathname과 로컬 경로 접두사를 같은 형식(슬래시 통일)으로 맞춘다. */
function normalizeForCompare(value: string): string {
  const slashes = value.replace(/\\/g, '/')
  // Windows file: URL은 '/C:/…'처럼 드라이브 문자 앞에 선행 슬래시가 붙는다 —
  // node:path 접두사('C:\…' → 'C:/…')와 비교하기 위해 잘라낸다.
  return /^\/[A-Za-z]:\//.test(slashes) ? slashes.slice(1) : slashes
}

export function isAllowedNavigation(url: string, policy: NavigationPolicy = {}): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:') {
    // 임의 로컬 파일이 앱 창에 로드되면 preload 브리지가 그 문맥에 주입된다 — renderer 경로로 한정.
    const prefix = policy.allowedFilePathPrefix
    if (!prefix) return false
    let localPath: string
    try {
      localPath = normalizeForCompare(decodeURIComponent(parsed.pathname))
    } catch {
      return false
    }
    const normalizedPrefix = normalizeForCompare(prefix)
    return (
      localPath === normalizedPrefix ||
      localPath.startsWith(
        normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`,
      )
    )
  }
  if (policy.dev && parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  }
  return false
}
