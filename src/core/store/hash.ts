import { createHash } from 'node:crypto'

/** 파일·문자열 콘텐츠의 sha256(변경 감지·캐리어 해시 공용). */
export function fileHashOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}
