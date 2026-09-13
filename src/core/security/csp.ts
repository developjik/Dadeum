/**
 * 엄격 CSP(Content-Security-Policy)를 단일 소스에서 생성한다.
 * main 프로세스(응답 헤더 주입)와 renderer(index.html 메타 태그)가 동일한 정책을 쓴다.
 * 정책 변경은 이 파일 하나에서만 일어나야 한다(계획 §6-7 보안 경계, M1 고정).
 */
export function buildCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
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
