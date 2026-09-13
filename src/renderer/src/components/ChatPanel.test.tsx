// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'
import { ChatPanel } from './ChatPanel'

/**
 * 채팅 입력의 키보드 계약:
 * - 일반 Enter는 전송, Shift+Enter는 줄바꿈, IME 조합 확정 Enter는 조합 확정(전송 아님).
 * main 프로세스 없이 preload API(window.confluenceLocal)만 흉내 낸다.
 */

const invokeCalls: Array<{ channel: string; payload?: unknown }> = []

beforeEach(() => {
  invokeCalls.length = 0
  window.confluenceLocal = {
    invoke: (channel, payload) => {
      invokeCalls.push({ channel, payload })
      if (channel === 'agent:run') return Promise.resolve({ runId: 'run-1' })
      return Promise.resolve({})
    },
    onAgentEvent: () => () => {},
    onSyncEvent: () => () => {},
    onUpdateEvent: () => () => {},
  }
  useAppStore.setState({
    chatMessages: [],
    agentRunning: false,
    agentStarting: false,
    activeRunId: undefined,
    agentStartAborted: false,
    activeSpaceKey: 'DEV',
    error: undefined,
    notice: undefined,
  })
})

afterEach(() => {
  cleanup()
  delete window.confluenceLocal
})

const sentChannels = (): string[] => invokeCalls.map((call) => call.channel)

describe('ChatPanel 입력 키 계약', () => {
  it('일반 Enter는 프롬프트를 전송하고 입력을 비운다', async () => {
    render(<ChatPanel />)
    const input = screen.getByPlaceholderText(ko.chat.placeholder) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '요약해줘' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sentChannels()).toContain('agent:run'))
    const call = invokeCalls.find((c) => c.channel === 'agent:run')
    expect(call?.payload).toEqual({ spaceKey: 'DEV', prompt: '요약해줘' })
    expect(input.value).toBe('')
  })

  it('IME 조합 확정 Enter(한글)는 전송하지 않고 입력을 보존한다', () => {
    render(<ChatPanel />)
    const input = screen.getByPlaceholderText(ko.chat.placeholder) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '한글 조합 중' } })

    // happy-dom 생성자 init은 isComposing을 보장하지 않는다 — 프로퍼티로 확정 주입
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(composing, 'isComposing', { value: true })
    input.dispatchEvent(composing)

    expect(sentChannels()).not.toContain('agent:run')
    expect(input.value).toBe('한글 조합 중')
  })

  it('Shift+Enter는 줄바꿈이므로 전송하지 않는다', () => {
    render(<ChatPanel />)
    const input = screen.getByPlaceholderText(ko.chat.placeholder) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '여러 줄' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(sentChannels()).not.toContain('agent:run')
    expect(input.value).toBe('여러 줄')
  })
})
