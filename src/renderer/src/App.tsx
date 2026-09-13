import { useEffect, useRef, useState } from 'react'
import { ko } from '../../core/i18n/ko'
import { ChatPanel } from './components/ChatPanel'
import { ConflictsPanel } from './components/ConflictsPanel'
import { ConnectForm } from './components/ConnectForm'
import { DocTree } from './components/DocTree'
import { EditorPane } from './components/Editor'
import {
  AlertIcon,
  BrandMark,
  CheckCircleIcon,
  CloseIcon,
  DocIcon,
  SettingsIcon,
  SyncIcon,
} from './components/icons'
import { Preview } from './components/Preview'
import { ReviewPanel } from './components/ReviewPanel'
import { SettingsDialog } from './components/SettingsDialog'
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
  const editing = useAppStore((s) => s.editing)
  const error = useAppStore((s) => s.error)
  const busy = useAppStore((s) => s.busy)
  const syncingSpace = useAppStore((s) => s.syncingSpace)
  const syncingProgress = useAppStore((s) => s.syncingProgress)
  const cancelPull = useAppStore((s) => s.cancelPull)
  const activeSpaceKey = useAppStore((s) => s.activeSpaceKey)
  const syncError = useAppStore((s) => s.syncError)
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
  const dismissNotice = useAppStore((s) => s.dismissNotice)
  const notice = useAppStore((s) => s.notice)
  const loadChangeset = useAppStore((s) => s.loadChangeset)
  const loadConflicts = useAppStore((s) => s.loadConflicts)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const updateNewVersion = useAppStore((s) => s.updateNewVersion)
  const updatePhase = useAppStore((s) => s.updatePhase)
  const updateProgress = useAppStore((s) => s.updateProgress)
  const checkUpdate = useAppStore((s) => s.checkUpdate)
  const installUpdate = useAppStore((s) => s.installUpdate)
  const [tab, setTab] = useState<TabKey>('document')
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 활성 스페이스 행 — 스페이스 전환 시 목록이 스크롤돼 있어도 보이게 가져온다 */
  const activeSpaceRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (activeSpaceKey) activeSpaceRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeSpaceKey])

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
  const activateTab = (next: TabKey, focus = false): void => {
    setTab(next)
    // 키보드 전환은 활성 탭으로 포커스를 옮긴다(포커스=활성 일치)
    if (focus) document.getElementById(`tab-${next}`)?.focus()
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
          {updatePhase === 'restarting' ? (
            <button type="button" className="btn btn--subtle app-header__update" disabled>
              {ko.update.restarting}
            </button>
          ) : updatePhase === 'downloading' ? (
            <button
              type="button"
              className="btn btn--subtle app-header__update"
              disabled
              aria-live="polite"
            >
              {ko.update.downloading(updateProgress ?? 0)}
            </button>
          ) : updateStatus === 'checking' ? (
            <button type="button" className="btn btn--subtle app-header__update" disabled>
              <span className="spinner" aria-hidden="true" />
              {ko.update.checking}
            </button>
          ) : updateStatus === 'available' ? (
            <button
              type="button"
              className="btn btn--primary app-header__update"
              onClick={() => void installUpdate()}
            >
              {ko.update.install(updateNewVersion ?? '')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--subtle app-header__update"
              onClick={() => void checkUpdate()}
            >
              {ko.update.check}
            </button>
          )}
          <span className="app-header__site">
            <span
              className={`status-dot${syncError ? ' status-dot--degraded' : ''}`}
              aria-hidden="true"
              title={syncError ? `${ko.sync.degraded} · ${syncError}` : undefined}
            />
            <span className="app-header__site-host">{siteHost(baseUrl)}</span>
          </span>
          {email ? <span className="app-header__email">{email}</span> : null}
          <button
            type="button"
            className="btn btn--icon btn--subtle"
            title={ko.aria.settings}
            aria-label={ko.aria.settings}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
          </button>
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
          {/* 잘린 에러 전문은 툴팁으로 확인할 수 있다 */}
          <span className="error-banner__text" title={error}>
            {error}
          </span>
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
          <button type="button" className="btn btn--subtle" onClick={dismissNotice}>
            <CloseIcon size={12} />
            {ko.common.close}
          </button>
        </div>
      ) : null}

      <div className="app-body">
        <aside className="sidebar">
          <section className="sidebar__spaces" aria-label={ko.aria.spaces}>
            <span className="section-label sidebar__spaces-label">{ko.sidebar.spaces}</span>
            <ul className="space-list">
              {spaces.map((space) => {
                const active = space.key === activeSpaceKey
                const syncing = syncingSpace === space.key
                return (
                  <li key={space.key} className="space-item">
                    <button
                      type="button"
                      ref={active ? activeSpaceRef : undefined}
                      className={`space-row${active ? ' space-row--active' : ''}`}
                      title={space.name}
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
                    {syncing ? (
                      <>
                        {syncingProgress?.spaceKey === space.key ? (
                          <span className="space-sync__progress">
                            {syncingProgress.done}/{syncingProgress.total}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn--icon btn--subtle space-sync"
                          title={ko.sync.pullCancel}
                          aria-label={ko.sync.pullCancel}
                          onClick={() => void cancelPull(space.key)}
                        >
                          <CloseIcon size={12} />
                        </button>
                      </>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
          <section className="sidebar__tree" aria-label={ko.aria.documents}>
            <span className="section-label">{ko.sidebar.pages}</span>
            <DocTree
              tree={tree}
              selectedPath={selected?.path}
              onOpen={(path) => {
                // 검토·충돌 탭에서 문서를 골랐을 때 미리보기가 가려져
                // 클릭이 무시된 것처럼 보이는 문제 — 문서 탭으로 전환한다.
                setTab('document')
                void openPage(path)
              }}
            />
          </section>
        </aside>

        <main className="main">
          {activeSpaceKey ? (
            <>
              <div
                className="tabs"
                aria-label={ko.aria.workspaceTabs}
                role="tablist"
                onKeyDown={(event) => {
                  // Arrow/Home/End 키로 탭 전환(활성화가 포커스를 따라간다)
                  const order: TabKey[] = ['document', 'review', 'conflict']
                  const current = order.indexOf(tab)
                  let next: number | null = null
                  if (event.key === 'ArrowRight') next = (current + 1) % order.length
                  else if (event.key === 'ArrowLeft')
                    next = (current + order.length - 1) % order.length
                  else if (event.key === 'Home') next = 0
                  else if (event.key === 'End') next = order.length - 1
                  if (next === null) return
                  event.preventDefault()
                  activateTab(order[next]!, true)
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id="tab-document"
                  aria-selected={tab === 'document'}
                  aria-controls="panel-document"
                  className={`tab${tab === 'document' ? ' tab--active' : ''}`}
                  onClick={() => setTab('document')}
                >
                  {ko.tabs.document}
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-review"
                  aria-selected={tab === 'review'}
                  aria-controls="panel-review"
                  className={`tab${tab === 'review' ? ' tab--active' : ''}`}
                  onClick={() => activateTab('review')}
                >
                  {ko.tabs.review}
                  {reviewCount > 0 ? <span className="tab__count">{reviewCount}</span> : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-conflict"
                  aria-selected={tab === 'conflict'}
                  aria-controls="panel-conflict"
                  className={`tab${tab === 'conflict' ? ' tab--active' : ''}`}
                  onClick={() => activateTab('conflict')}
                >
                  {ko.tabs.conflict}
                  {conflictCount > 0 ? <span className="tab__count">{conflictCount}</span> : null}
                </button>
              </div>
              <div className="tab-panel">
                {/*
                  패널은 숨김으로 계속 마운트한다 — 탭을 왕복해도 검토 선택·펼친 diff·
                  스크롤 위치가 유지된다. key로 스페이스 전환 시에만 상태를 초기화한다.
                */}
                <div
                  id="panel-document"
                  role="tabpanel"
                  aria-labelledby="tab-document"
                  className="tab-panel__page"
                  hidden={tab !== 'document'}
                >
                  {selected ? (
                    // 편집 세션은 문서 경로에 귀속 — 같은 문서를 보고 있을 때만 에디터로 바꾼다
                    editing && editing.path === selected.path ? (
                      <EditorPane page={selected} />
                    ) : (
                      <Preview page={selected} />
                    )
                  ) : (
                    <div className="empty-state">
                      <DocIcon size={28} />
                      <p>{ko.preview.empty}</p>
                    </div>
                  )}
                </div>
                <div
                  id="panel-review"
                  role="tabpanel"
                  aria-labelledby="tab-review"
                  className="tab-panel__page"
                  hidden={tab !== 'review'}
                >
                  <ReviewPanel key={activeSpaceKey} spaceKey={activeSpaceKey} />
                </div>
                <div
                  id="panel-conflict"
                  role="tabpanel"
                  aria-labelledby="tab-conflict"
                  className="tab-panel__page"
                  hidden={tab !== 'conflict'}
                >
                  <ConflictsPanel key={activeSpaceKey} spaceKey={activeSpaceKey} />
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <DocIcon size={28} />
              <p>{ko.main.noSpace}</p>
            </div>
          )}
        </main>

        <section className="chat-rail" aria-label={ko.aria.agentChat}>
          {activeSpaceKey ? <ChatPanel /> : null}
        </section>
      </div>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}
