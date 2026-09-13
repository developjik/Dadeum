import { useEffect, useState } from 'react'
import { ko } from '../../core/i18n/ko'
import { ChatPanel } from './components/ChatPanel'
import { ConflictsPanel } from './components/ConflictsPanel'
import { ConnectForm } from './components/ConnectForm'
import { DocTree } from './components/DocTree'
import {
  AlertIcon,
  BrandMark,
  CheckCircleIcon,
  CloseIcon,
  DocIcon,
  SyncIcon,
} from './components/icons'
import { Preview } from './components/Preview'
import { ReviewPanel } from './components/ReviewPanel'
import { ensureAgentEventSubscription, useAppStore } from './state/appStore'

type TabKey = 'document' | 'review' | 'conflict'

function siteHost(baseUrl: string | undefined): string {
  if (!baseUrl) return ''
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function App(): React.ReactElement {
  const status = useAppStore((s) => s.status)
  const spaces = useAppStore((s) => s.spaces)
  const tree = useAppStore((s) => s.tree)
  const selected = useAppStore((s) => s.selected)
  const error = useAppStore((s) => s.error)
  const busy = useAppStore((s) => s.busy)
  const syncingSpace = useAppStore((s) => s.syncingSpace)
  const activeSpaceKey = useAppStore((s) => s.activeSpaceKey)
  const baseUrl = useAppStore((s) => s.baseUrl)
  const email = useAppStore((s) => s.email)
  const changeset = useAppStore((s) => s.changeset)
  const conflicts = useAppStore((s) => s.conflicts)
  const refreshStatus = useAppStore((s) => s.refreshStatus)
  const pullSpace = useAppStore((s) => s.pullSpace)
  const openPage = useAppStore((s) => s.openPage)
  const selectSpace = useAppStore((s) => s.selectSpace)
  const disconnect = useAppStore((s) => s.disconnect)
  const dismissError = useAppStore((s) => s.dismissError)
  const notice = useAppStore((s) => s.notice)
  const loadChangeset = useAppStore((s) => s.loadChangeset)
  const loadConflicts = useAppStore((s) => s.loadConflicts)
  const [tab, setTab] = useState<TabKey>('document')

  useEffect(() => {
    ensureAgentEventSubscription()
    void refreshStatus()
  }, [refreshStatus])

  if (status === 'loading') {
    return (
      <main className="gate-screen">
        <div className="loading-card">
          <span className="loading-card__brand">
            <BrandMark />
            {ko.app.title}
          </span>
          <span className="spinner" aria-hidden="true" />
          <span>{ko.app.loading}</span>
        </div>
      </main>
    )
  }

  if (status === 'disconnected') {
    return (
      <main className="gate-screen">
        <ConnectForm />
      </main>
    )
  }

  const reviewCount = changeset
    ? changeset.modified.length +
      changeset.added.length +
      changeset.attachments.length +
      changeset.missing.length
    : 0
  const conflictCount = conflicts.length

  /** 탭 진입 시 해당 패널 데이터를 새로 불러온다(기존 버튼 동작 승계). */
  const activateTab = (next: TabKey): void => {
    setTab(next)
    if (!activeSpaceKey) return
    if (next === 'review') void loadChangeset(activeSpaceKey)
    if (next === 'conflict') void loadConflicts(activeSpaceKey)
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-header__brand">
          <BrandMark />
          {ko.app.title}
        </span>
        <div className="app-header__meta">
          <span className="app-header__site">
            <span className="status-dot" aria-hidden="true" />
            <span className="app-header__site-host">{siteHost(baseUrl)}</span>
          </span>
          {email ? <span className="app-header__email">{email}</span> : null}
          <button
            type="button"
            className="btn btn--subtle"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {ko.auth.disconnect}
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <AlertIcon size={14} />
          <span className="error-banner__text">{error}</span>
          <button type="button" className="btn btn--subtle" onClick={dismissError}>
            <CloseIcon size={12} />
            {ko.common.close}
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="notice-banner" role="status">
          <CheckCircleIcon size={14} />
          <span className="notice-banner__text">{notice}</span>
        </div>
      ) : null}

      <div className="app-body">
        <aside className="sidebar">
          <section className="sidebar__spaces" aria-label="spaces">
            <span className="section-label sidebar__spaces-label">{ko.sidebar.spaces}</span>
            <ul className="space-list">
              {spaces.map((space) => {
                const active = space.key === activeSpaceKey
                const syncing = syncingSpace === space.key
                return (
                  <li key={space.key} className="space-item">
                    <button
                      type="button"
                      className={`space-row${active ? ' space-row--active' : ''}`}
                      onClick={() => void selectSpace(space.key)}
                    >
                      <span className="space-row__name">{space.name}</span>
                      <span className="space-row__key">{space.key}</span>
                    </button>
                    <button
                      type="button"
                      className={`btn btn--icon btn--subtle space-sync${syncing ? ' space-sync--syncing' : ''}`}
                      disabled={busy}
                      title={syncing ? ko.sync.pulling : ko.sync.pull}
                      aria-label={syncing ? ko.sync.pulling : ko.sync.pull}
                      onClick={() => void pullSpace(space.key)}
                    >
                      {syncing ? <span className="spinner" aria-hidden="true" /> : <SyncIcon />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
          <section className="sidebar__tree" aria-label="documents">
            <span className="section-label">{ko.sidebar.pages}</span>
            <DocTree
              tree={tree}
              selectedPath={selected?.path}
              onOpen={(path) => void openPage(path)}
            />
          </section>
        </aside>

        <main className="main">
          {activeSpaceKey ? (
            <>
              <nav className="tabs" aria-label="workspace-tabs">
                <button
                  type="button"
                  className={`tab${tab === 'document' ? ' tab--active' : ''}`}
                  onClick={() => setTab('document')}
                >
                  {ko.tabs.document}
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'review' ? ' tab--active' : ''}`}
                  onClick={() => activateTab('review')}
                >
                  {ko.tabs.review}
                  {reviewCount > 0 ? <span className="tab__count">{reviewCount}</span> : null}
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'conflict' ? ' tab--active' : ''}`}
                  onClick={() => activateTab('conflict')}
                >
                  {ko.tabs.conflict}
                  {conflictCount > 0 ? <span className="tab__count">{conflictCount}</span> : null}
                </button>
              </nav>
              <div className="tab-panel">
                {tab === 'document' ? (
                  selected ? (
                    <Preview page={selected} />
                  ) : (
                    <div className="empty-state">
                      <DocIcon size={28} />
                      <p>{ko.preview.empty}</p>
                    </div>
                  )
                ) : null}
                {tab === 'review' ? <ReviewPanel spaceKey={activeSpaceKey} /> : null}
                {tab === 'conflict' ? <ConflictsPanel spaceKey={activeSpaceKey} /> : null}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <DocIcon size={28} />
              <p>{ko.main.noSpace}</p>
            </div>
          )}
        </main>

        <section className="chat-rail" aria-label="agent-chat">
          {activeSpaceKey ? <ChatPanel /> : null}
        </section>
      </div>
    </div>
  )
}
