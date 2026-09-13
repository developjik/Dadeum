/**
 * 엄격 CSP(Content-Security-Policy)를 단일 소스에서 생성한다.
 * main 프로세스(응답 헤더 주입)와 renderer(index.html 메타 태그)가 동일한 정책을 쓴다.
 * 정책 변경은 이 파일 하나에서만 일어나야 한다(계획 §6-7 보안 경계, M1 고정).
 */
export interface CspOptions {
  /**
   * 개발 모드 — @vitejs/plugin-react가 index.html에 주입하는 React Fast Refresh
   * 프리앰블은 인라인 script라서 'self'만으로는 차단된다(프로덕션 빌드에는 프리앰블이
   * 없으므로 빌드 결과물은 완화 없이 엄격하게 유지된다).
   */
  dev?: boolean
}

export function buildCsp(options: CspOptions = {}): string {
  const scriptSrc = options.dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}
