import { describe, expect, it } from 'vitest'
import { ko } from './ko'

/** 중첩 객체의 모든 말단 값을 순회한다. */
function* leafValues(node: unknown): Generator<string> {
  if (typeof node === 'function') return
  if (typeof node === 'string') {
    yield node
    return
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) yield* leafValues(value)
  }
}

describe('ko 문안 단일 소스', () => {
  it('모든 문자열 문안은 비어 있지 않다', () => {
    for (const value of leafValues(ko)) {
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })

  it('동기화 상태 배지 문안이 계획 §8.2와 일치한다', () => {
    expect(ko.sync.idle).toBe('대기')
    expect(ko.sync.pulling).toBe('동기화 중')
    expect(ko.sync.pushing).toBe('업로드 중')
    expect(ko.sync.agentRunning).toBe('에이전트 편집 중')
    expect(ko.sync.deferred).toBe('동기화 보류')
    expect(ko.sync.conflictCandidates(3)).toBe('충돌 후보 3건')
  })

  it('충돌 3지 선택 문안이 스펙 ef-8과 일치한다', () => {
    expect(ko.conflict.overwrite).toBe('내 로컬 버전으로 업로드')
    expect(ko.conflict.takeRemote).toBe('원격 최신본으로 교체')
    expect(ko.conflict.manualMerge).toBe('diff 보고 직접 처리')
  })

  it('앱 제목이 한국어다', () => {
    expect(ko.app.title).toBe('Confluence 로컬')
  })
})
