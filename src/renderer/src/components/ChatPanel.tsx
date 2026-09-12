import { useEffect, useRef, useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'

export function ChatPanel(): React.ReactElement {
  const messages = useAppStore((s) => s.chatMessages)
  const agentRunning = useAppStore((s) => s.agentRunning)
  const sendChat = useAppStore((s) => s.sendChat)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  return (
    <section aria-label="agent-chat">
      <div ref={listRef} className="chat-messages">
        {messages.map((message, index) => (
          <p key={index} className={`chat-${message.role}`}>
            {message.text}
          </p>
        ))}
        {messages.length === 0 ? <p className="chat-system">{ko.chat.placeholder}</p> : null}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const prompt = input.trim()
          if (prompt.length === 0 || agentRunning) return
          setInput('')
          void sendChat(prompt)
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={ko.chat.placeholder} />
        {agentRunning ? (
          <button type="button" onClick={() => void useAppStore.getState().cancelAgent()}>
            {ko.chat.cancel}
          </button>
        ) : (
          <button type="submit">{ko.chat.send}</button>
        )}
      </form>
    </section>
  )
}
