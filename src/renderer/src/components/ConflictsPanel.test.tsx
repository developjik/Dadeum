// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'
import { ConflictsPanel } from './ConflictsPanel'

/**
 * 충돌 패널의 '직접 처리' 계약:
 * 선택 즉시 conflict:resolve(manual)를 보내고 pages:diff 결과를
 * 카드 아래에 인라인으로 렌더해야 한다(예전에는 diff를 불러만 두고 화면에 안 보였다).
 */

const invokeCalls: Array<{ channel: string; payload?: unknown }> = []
const conflict = { pageId: '1001', path: 'spaces/DEV/가이드/index.md', reason: 'dirty' as const }

beforeEach(() => {
  invokeCalls.length = 0
  window.confluenceLocal = {
    invoke: (channel, payload) => {
      invokeCalls.push({ channel, payload })
      if (channel === 'pages:diff') {
        return Promise.resolve({
          path: conflict.path,
          changes: [
            { type: 'removed', value: '이전 본문' },
            { type: 'added', value: '새 본문' },
          ],
        })
      }
      if (channel === 'conflict:list') {
        // 수동 병합 선택 직후에도 dirty 후보는 유지된다(사용자 병합 완료 전까지)
        return Promise.resolve({ candidates: [conflict] })
      }
      return Promise.resolve({})
    },
    onAgentEvent: () => () => {},
    onSyncEvent: () => () => {},
    onUpdateEvent: () => () => {},
  }
  useAppStore.setState({
    conflicts: [conflict],
    diffs: {},
    busy: false,
    activeSpaceKey: 'DEV',
    error: undefined,
    notice: undefined,
  })
})

afterEach(() => {
  cleanup()
  delete window.confluenceLocal
})

describe('ConflictsPanel 직접 처리', () => {
  it('직접 처리 선택 시 diff를 카드 아래에 인라인 렌더한다', async () => {
    render(<ConflictsPanel spaceKey="DEV" />)
    expect(document.querySelector('.conflict-card__diff')).toBeNull()

    fireEvent.click(screen.getByText(ko.conflict.manualMerge))

    await waitFor(() => expect(document.querySelector('.conflict-card__diff')).not.toBeNull())
    expect(document.querySelector('.diff-line--removed')?.textContent).toContain('이전 본문')
    expect(document.querySelector('.diff-line--added')?.textContent).toContain('새 본문')
    const resolve = invokeCalls.find((call) => call.channel === 'conflict:resolve')
    expect((resolve?.payload as { choice?: string })?.choice).toBe('manual')
  })

  it('이미 불러온 diff가 있으면 패널을 열 때 바로 보여준다', () => {
    useAppStore.setState({
      diffs: { [conflict.path]: [{ type: 'removed', value: '과거 본문' }] },
    })
    render(<ConflictsPanel spaceKey="DEV" />)

    expect(document.querySelector('.conflict-card__diff')).not.toBeNull()
    expect(document.querySelector('.diff-line--removed')?.textContent).toContain('과거 본문')
  })

  it('원격 삭제 후보는 직접 처리 버튼을 노출하지 않는다', () => {
    useAppStore.setState({
      conflicts: [{ ...conflict, reason: 'remote-deleted' }],
      diffs: { [conflict.path]: [{ type: 'added', value: 'x' }] },
    })
    render(<ConflictsPanel spaceKey="DEV" />)

    expect(screen.queryByText(ko.conflict.manualMerge)).toBeNull()
    expect(document.querySelector('.conflict-card__diff')).toBeNull()
  })
})
