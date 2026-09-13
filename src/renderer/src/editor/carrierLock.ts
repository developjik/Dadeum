/**
 * CodeMirror 6 캐리어 잠금 확장.
 * confluence-storage 펜스 블록을 시각적으로 구분하고(점선·잠금 표시)
 * 블록 내부를 침범하는 모든 변경 트랜잭션을 거부한다(UX 게이트 —
 * 최종 방어선은 저장 시 markdownToStorage 무결성 검증이다).
 */
import { EditorState, type Extension, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { type CarrierRange, findCarrierRanges } from '../../../core/editor/carrierRanges'

const carrierLine = Decoration.line({ class: 'cm-carrier-block' })

interface CarrierState {
  ranges: CarrierRange[]
  decorations: DecorationSet
}

/** 문서 전체를 훑으며 캐리어 라인에 줄 장식을 붙인다(문서 길이에 선형). */
function buildCarrierState(docText: string): CarrierState {
  const ranges = findCarrierRanges(docText)
  const decorated: Array<{ from: number; to: number; value: typeof carrierLine }> = []
  const lines = docText.split('\n')
  let cursor = 0
  let rangeIndex = 0
  for (const line of lines) {
    const lineFrom = cursor
    const lineTo = cursor + line.length
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.to < lineFrom) rangeIndex += 1
    const range = ranges[rangeIndex]
    if (range && lineFrom >= range.from && lineTo <= range.to) {
      decorated.push({ from: lineFrom, to: lineFrom, value: carrierLine })
    }
    cursor = lineTo + 1
  }
  return { ranges, decorations: Decoration.set(decorated) }
}

const carrierField = StateField.define<CarrierState>({
  create(state) {
    return buildCarrierState(state.doc.toString())
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value
    return buildCarrierState(transaction.state.doc.toString())
  },
})

/**
 * 캐리어 구간과 겹치는 변경이면 트랜잭션을 폐기한다([] 반환 = 변경 없음).
 * 경계 바로 뒤 삽입(fromA === r.to)은 허용해 블록 다음 줄 편집이 막히지 않게 한다.
 * 전체 선택 후 입력처럼 허용 구간과 잠금 구간이 한 트랜잭션에 섞이면 통째로 거부한다
 * — 부분 적용은 캐리어 훼손 경로가 될 수 있어 보수적으로 판정한다.
 */
const lockCarriers = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  const ranges = tr.startState.field(carrierField, false)?.ranges
  if (!ranges || ranges.length === 0) return tr
  let blocked = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const range of ranges) {
      if (fromA < range.to && toA > range.from) {
        blocked = true
        return
      }
    }
  })
  return blocked ? [] : tr
})

/** 에디터에 붙이는 확장 묶음 — 캐리어 잠금 + 줄바꿈. */
export function carrierLock(): Extension[] {
  return [
    carrierField,
    EditorView.decorations.of((view) => view.state.field(carrierField).decorations),
    lockCarriers,
    EditorView.lineWrapping,
  ]
}
