import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 컴포넌트 테스트(.test.tsx)는 파일 상단 @vitest-environment docblock으로
    // happy-dom 환경을 지정한다(기본은 node — 코어 로직은 DOM 없이 돌아간다).
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html'],
    },
  },
})
