/**
 * electron-vite가 번들하는 CSS 사이드 이펙트 임포트용 타입 선언.
 * export가 없는 전역 스크립트 컨텍스트여야 와일드카드 앰비언트 모듈로 등록된다.
 */
declare module '*.css' {
  const css: string
  export default css
}
