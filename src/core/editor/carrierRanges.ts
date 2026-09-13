/**
 * 캐리어 펜스 블록 스캐너(순수 로직 — renderer에서도 import한다).
 * node 의존이 없어야 한다(renderer-no-node 규칙). 해시 무결성 검증은
 * node:crypto가 필요하므로 main 쪽 pageWrite이 담당한다.
 */
import { CARRIER_LANG } from '../converter/carrierTokens'

export interface CarrierRange {
  /** 펜스 블록 전체(여는 펜스 라인 시작 ~ 닫는 펜스 라인 끝) */
  from: number
  to: number
  /** 펜스 내용(XML 본문) 구간 — 여는 라인 다음 ~ 닫는 라인 직전 */
  contentFrom: number
  contentTo: number
  /** info string의 id(없으면 null — id 없는 펜스는 push 검증 대상이 아니나 잠금은 한다) */
  id: string | null
  name: string | null
}

const OPEN_FENCE = /^(`{3,})[ \t]*(.*)$/
const CLOSE_FENCE = /^[ \t]*(`{3,})[ \t]*$/

/**
 * 문서에서 confluence-storage 펜스 블록의 위치를 찾는다.
 * 닫는 펜스는 여는 펜스보다 길거나 같은 백틱 런이어야 한다(CommonMark 규칙 —
 * 내용에 ```가 포함돼도 조기 종료되지 않는 carriers.ts fenceFor 규약과 대응).
 * 닫히지 않은 펜스는 잠그지 않는다(저장 게이트가 무결성으로 수습).
 */
export function findCarrierRanges(text: string): CarrierRange[] {
  const ranges: CarrierRange[] = []
  const lines = text.split('\n')
  let lineStart = 0
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    const opened = line.match(OPEN_FENCE)
    if (opened) {
      const info = opened[2] ?? ''
      if (info.startsWith(CARRIER_LANG)) {
        const openRun = opened[1]!.length
        const from = lineStart
        const contentFrom = lineStart + line.length + 1
        let closeIndex = -1
        let closeLineStart = -1
        let scan = index + 1
        let scanStart = contentFrom
        while (scan < lines.length) {
          const candidate = lines[scan]!.match(CLOSE_FENCE)
          if (candidate && candidate[1]!.length >= openRun) {
            closeIndex = scan
            closeLineStart = scanStart
            break
          }
          scanStart += lines[scan]!.length + 1
          scan += 1
        }
        if (closeIndex !== -1) {
          // contentTo는 내용과 닫는 펜스 사이 개행을 제외한 지점(빈 내용 방어 포함)
          const contentTo = Math.max(contentFrom, closeLineStart - 1)
          const to = closeLineStart + lines[closeIndex]!.length
          ranges.push({
            from,
            to,
            contentFrom,
            contentTo,
            id: attrOf(info, 'id'),
            name: attrOf(info, 'name'),
          })
          index = closeIndex + 1
          // 닫는 라인 끝의 개행을 건너뛴 다음 줄 시작점(마지막 라인이면 초과해도 무해)
          lineStart = to + 1
          continue
        }
      }
    }
    lineStart += line.length + 1
    index += 1
  }
  return ranges
}

/** info string에서 `key=value` 토큰을 꺼낸다(markdownToStorage.carrierMeta와 같은 규약). */
function attrOf(info: string, key: string): string | null {
  for (const token of info.split(/\s+/)) {
    if (!token.includes('=')) continue
    if (token.slice(0, token.indexOf('=')) === key) {
      return token.slice(token.indexOf('=') + 1)
    }
  }
  return null
}
