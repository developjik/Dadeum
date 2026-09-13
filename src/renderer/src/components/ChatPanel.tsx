import { useEffect, useRef, useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'
import { ChatIcon, SendIcon, StopIcon } from './icons'

export function ChatPanel(): React.ReactElement {
  const messages = useAppStore((s) => s.chatMessages)
  const agentRunning = useAppStore((s) => s.agentRunning)
  const sendChat = useAppStore((s) => s.sendChat)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (messages.length === 0 && !agentRunning) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, agentRunning])

  /** 내용 높이에 맞춰 입력창을 늘린다(CSS min/max-height가 범위를 제한). */
  const autosizeInput = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const send = (): void => {
    const prompt = input.trim()
    if (prompt.length === 0 || agentRunning) return
    setInput('')
    if (inputRef.current) inputRef.current.style.height = ''
    void sendChat(prompt)
  }

  const lastRole = messages.length > 0 ? messages[messages.length - 1]?.role : undefined

  return (
    <>
      <header className="chat-rail__header">
        <ChatIcon />
        {ko.chat.title}
        {agentRunning ? (
          <span className="chat-rail__status">
            <span className="spinner spinner--xs" aria-hidden="true" />
            {ko.sync.agentRunning}
          </span>
        ) : null}
      </header>
      <div ref={listRef} className="chat-messages">
        {messages.map((message, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only 채팅 로그라 순서 변경·삭제가 없다
          <p key={index} className={`chat-message chat-message--${message.role}`}>
            {message.text}
          </p>
        ))}
        {agentRunning && lastRole !== 'assistant' ? (
          <span className="chat-typing" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        ) : null}
        {messages.length === 0 && !agentRunning ? (
          <p className="chat-empty">{ko.chat.empty}</p>
        ) : null}
      </div>
      <form
        className="chat-inputbar"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <textarea
          ref={inputRef}
          className="text-input chat-inputbar__textarea"
          rows={2}
          value={input}
          aria-label={ko.chat.placeholder}
          onChange={(e) => {
            setInput(e.target.value)
            autosizeInput()
          }}
          onKeyDown={(e) => {
            // Enter는 전송, Shift+Enter는 줄바꿈(여러 줄 지시 지원)
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={ko.chat.placeholder}
        />
        {agentRunning ? (
          <button
            type="button"
            className="btn btn--default chat-stop"
            onClick={() => void useAppStore.getState().cancelAgent()}
          >
            <StopIcon />
            {ko.chat.cancel}
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn--primary chat-send"
            disabled={input.trim().length === 0}
          >
            <SendIcon />
            {ko.chat.send}
          </button>
        )}
      </form>
    </>
  )
}
