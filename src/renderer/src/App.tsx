import { useEffect } from 'react'
import { ko } from '../../core/i18n/ko'
import { useAppStore, ensureAgentEventSubscription } from './state/appStore'
import { ConnectForm } from './components/ConnectForm'
import { DocTree } from './components/DocTree'
import { Preview } from './components/Preview'
import { ChatPanel } from './components/ChatPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { ConflictsPanel } from './components/ConflictsPanel'

export function App(): React.ReactElement {
  const status = useAppStore((s) => s.status)
  const spaces = useAppStore((s) => s.spaces)
  const tree = useAppStore((s) => s.tree)
  const selected = useAppStore((s) => s.selected)
  const error = useAppStore((s) => s.error)
  const busy = useAppStore((s) => s.busy)
  const syncingSpace = useAppStore((s) => s.syncingSpace)
  const refreshStatus = useAppStore((s) => s.refreshStatus)
  const pullSpace = useAppStore((s) => s.pullSpace)
  const openPage = useAppStore((s) => s.openPage)
  const selectSpace = useAppStore((s) => s.selectSpace)
  const activeSpaceKey = useAppStore((s) => s.activeSpaceKey)

  useEffect(() => {
    ensureAgentEventSubscription()
    void refreshStatus()
  }, [refreshStatus])

  if (status === 'loading') {
    return (
      <main>
        <h1>{ko.app.title}</h1>
        <p>{ko.sync.idle}</p>
      </main>
    )
  }

  if (status === 'disconnected') {
    return (
      <main>
        <h1>{ko.app.title}</h1>
        <ConnectForm />
      </main>
    )
  }

  return (
    <main className="workspace">
      <aside>
        <h2>{ko.auth.connect}</h2>
        <ul>
          {spaces.map((space) => (
            <li key={space.key}>
              <button type="button" onClick={() => void selectSpace(space.key)}>
                <strong>{space.name}</strong> ({space.key})
              </button>
              <button type="button" disabled={busy} onClick={() => void pullSpace(space.key)}>
                {syncingSpace === space.key ? ko.sync.pulling : ko.sync.idle}
              </button>
            </li>
          ))}
        </ul>
        <DocTree tree={tree} onOpen={(path) => void openPage(path)} />
      </aside>
      <section className="content">
        {selected ? <Preview page={selected} /> : <p>{ko.preview.empty}</p>}
        {activeSpaceKey ? <ReviewPanel spaceKey={activeSpaceKey} /> : null}
        {activeSpaceKey ? <ConflictsPanel spaceKey={activeSpaceKey} /> : null}
      </section>
      <section className="chat">
        {activeSpaceKey ? <ChatPanel /> : null}
      </section>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  )
}
