import BetterSqlite3 from 'better-sqlite3'

/**
 * 동기화 상태 정준 원천(계획 §6-5, F-11).
 * frontmatter는 힌트이고 이 DB가 진실이다 — 에이전트가 파일을 오염시켜도
 * push 경로는 항상 이 DB와 재검증한다.
 */
export interface PageRecord {
  pageId: string
  spaceKey: string
  path: string
  title: string
  version: number
  parentId: string | null
  contentHash: string | null
  updatedAt: string | null
  syncedAt: string
  remoteDeleted: boolean
  /** 마지막 동기화 시점의 정규화 마크다운 본문(3-way 병합의 공통 조상) */
  baseBody: string | null
  baseVersion: number | null
}

export interface AttachmentRecord {
  pageId: string
  fileName: string
  mediaType: string | null
  fileHash: string | null
  syncedAt: string
}

export class SyncStateDb {
  private readonly db: BetterSqlite3.Database

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        page_id TEXT PRIMARY KEY,
        space_key TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_id TEXT,
        content_hash TEXT,
        updated_at TEXT,
        synced_at TEXT NOT NULL,
        remote_deleted INTEGER NOT NULL DEFAULT 0,
        base_body TEXT,
        base_version INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_key);

      CREATE TABLE IF NOT EXISTS attachments (
        page_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT,
        file_hash TEXT,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (page_id, file_name)
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        space_key TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_settings (
        space_key TEXT PRIMARY KEY,
        adapter_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pull_log (
        space_key TEXT PRIMARY KEY,
        started_at TEXT NOT NULL
      );
    `)
    // 스키마 버전 스탬프 — 향후 변경은 user_version 기반 순차 마이그레이션 단계를 추가한다
    // (v1은 전 테이블이 IF NOT EXISTS 멱등 생성이라 기존 워크스페이스와 호환).
    // v2: agent_settings(스페이스별 에이전트 어댑터 선택) 추가 — 역시 멱등 생성.
    // v3: pages에 base_body·base_version(마지막 동기화 기준본) 추가 — 신규 db는 생성에
    // 포함되고 기존 db는 ALTER로 얻는다(순차 단계).
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version < 3) {
      const columns = new Set(
        (this.db.pragma('table_info(pages)') as Array<{ name: string }>).map((col) => col.name),
      )
      if (!columns.has('base_body')) this.db.exec('ALTER TABLE pages ADD COLUMN base_body TEXT')
      if (!columns.has('base_version')) {
        this.db.exec('ALTER TABLE pages ADD COLUMN base_version INTEGER')
      }
      this.db.pragma('user_version = 3')
    }
  }

  /** 여러 쓰기를 하나의 트랜잭션으로 묶는다 — 대량 pull의 문장별 fsync 병목 감소. */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }

  upsertPage(page: {
    pageId: string
    spaceKey: string
    path: string
    title: string
    version: number
    parentId?: string | null
    contentHash?: string | null
    updatedAt?: string | null
    syncedAt?: string
    remoteDeleted?: boolean
  }): void {
    this.db
      .prepare(
        `INSERT INTO pages (page_id, space_key, path, title, version, parent_id, content_hash, updated_at, synced_at, remote_deleted)
         VALUES (@pageId, @spaceKey, @path, @title, @version, @parentId, @contentHash, @updatedAt, @syncedAt, @remoteDeleted)
         ON CONFLICT(page_id) DO UPDATE SET
           space_key=@spaceKey, path=@path, title=@title, version=@version, parent_id=@parentId,
           content_hash=@contentHash, updated_at=@updatedAt, synced_at=@syncedAt,
           remote_deleted=@remoteDeleted`,
      )
      .run({
        pageId: page.pageId,
        spaceKey: page.spaceKey,
        path: page.path,
        title: page.title,
        version: page.version,
        parentId: page.parentId ?? null,
        contentHash: page.contentHash,
        updatedAt: page.updatedAt,
        syncedAt: page.syncedAt ?? new Date().toISOString(),
        remoteDeleted: page.remoteDeleted ? 1 : 0,
      })
  }

  getPage(pageId: string): PageRecord | null {
    const row = this.db.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId) as
      | Parameters<SyncStateDb['toPage']>[0]
      | undefined
    return row ? this.toPage(row) : null
  }

  getPageByPath(path: string): PageRecord | null {
    const row = this.db.prepare('SELECT * FROM pages WHERE path = ?').get(path) as
      | Parameters<SyncStateDb['toPage']>[0]
      | undefined
    return row ? this.toPage(row) : null
  }

  listPagesBySpace(spaceKey: string): PageRecord[] {
    const rows = this.db.prepare('SELECT * FROM pages WHERE space_key = ?').all(spaceKey) as Array<
      Parameters<SyncStateDb['toPage']>[0]
    >
    return rows.map((row) => this.toPage(row))
  }

  /** 워크스페이스에 기록된 스페이스 키 목록(재시작 시 자동 폴링 복원용). */
  listSpaceKeys(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT space_key FROM pages ORDER BY space_key')
      .all() as Array<{ space_key: string }>
    return rows.map((row) => row.space_key)
  }

  /** 스페이스의 마지막 동기화 시각(최대 synced_at) — 증분 폴링 기준점으로 사용. */
  lastSyncedAt(spaceKey: string): string | null {
    const row = this.db
      .prepare('SELECT MAX(synced_at) AS last FROM pages WHERE space_key = ?')
      .get(spaceKey) as { last?: string | null }
    return row.last ?? null
  }

  /** 스페이스의 마지막 'pull 시작 시각' — 증분 기준점(진행 중 변경 유실 방지). */
  lastPullStartAt(spaceKey: string): string | null {
    const row = this.db
      .prepare('SELECT started_at FROM pull_log WHERE space_key = ?')
      .get(spaceKey) as { started_at?: string | null } | undefined
    return row?.started_at ?? null
  }

  recordPullStart(spaceKey: string, startedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO pull_log (space_key, started_at) VALUES (?, ?)
         ON CONFLICT(space_key) DO UPDATE SET started_at = excluded.started_at`,
      )
      .run(spaceKey, startedAt)
  }

  deleteAttachment(pageId: string, fileName: string): void {
    this.db
      .prepare('DELETE FROM attachments WHERE page_id = ? AND file_name = ?')
      .run(pageId, fileName)
  }

  markRemoteDeleted(pageId: string): void {
    this.db.prepare('UPDATE pages SET remote_deleted = 1 WHERE page_id = ?').run(pageId)
  }

  clearRemoteDeleted(pageId: string): void {
    this.db.prepare('UPDATE pages SET remote_deleted = 0 WHERE page_id = ?').run(pageId)
  }

  updateContentHash(pageId: string, contentHash: string | null): void {
    this.db
      .prepare('UPDATE pages SET content_hash = ?, synced_at = ? WHERE page_id = ?')
      .run(contentHash, new Date().toISOString(), pageId)
  }

  /** 마지막 동기화 시점의 기준본(base copy)을 기록한다 — pull·push 완료 시점에만 갱신. */
  setBaseCopy(pageId: string, baseBody: string, baseVersion: number): void {
    this.db
      .prepare('UPDATE pages SET base_body = ?, base_version = ? WHERE page_id = ?')
      .run(baseBody, baseVersion, pageId)
  }

  upsertAttachment(attachment: Omit<AttachmentRecord, 'syncedAt'> & { syncedAt?: string }): void {
    this.db
      .prepare(
        `INSERT INTO attachments (page_id, file_name, media_type, file_hash, synced_at)
         VALUES (@pageId, @fileName, @mediaType, @fileHash, @syncedAt)
         ON CONFLICT(page_id, file_name) DO UPDATE SET
           media_type=@mediaType, file_hash=@fileHash, synced_at=@syncedAt`,
      )
      .run({
        pageId: attachment.pageId,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        fileHash: attachment.fileHash,
        syncedAt: attachment.syncedAt ?? new Date().toISOString(),
      })
  }

  listAttachmentsByPage(pageId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE page_id = ?')
      .all(pageId) as Array<{
      page_id: string
      file_name: string
      media_type: string | null
      file_hash: string | null
      synced_at: string
    }>
    return rows.map((row) => ({
      pageId: row.page_id,
      fileName: row.file_name,
      mediaType: row.media_type,
      fileHash: row.file_hash,
      syncedAt: row.synced_at,
    }))
  }

  /** ChatSession(스페이스 스코프) ↔ 에이전트 세션 id 1:1 매핑(계획 §8.5). */
  getAgentSessionId(spaceKey: string): string | null {
    const row = this.db
      .prepare('SELECT agent_session_id FROM chat_sessions WHERE space_key = ?')
      .get(spaceKey) as { agent_session_id?: string } | undefined
    return row?.agent_session_id ?? null
  }

  setAgentSessionId(spaceKey: string, agentSessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_sessions (space_key, agent_session_id, updated_at)
         VALUES (@spaceKey, @agentSessionId, @updatedAt)
         ON CONFLICT(space_key) DO UPDATE SET
           agent_session_id=@agentSessionId, updated_at=@updatedAt`,
      )
      .run({
        spaceKey,
        agentSessionId,
        updatedAt: new Date().toISOString(),
      })
  }

  /** 스페이스가 사용할 에이전트 어댑터 이름(미섀장 시 null = 기본 어댑터). */
  getAgentAdapterName(spaceKey: string): string | null {
    const row = this.db
      .prepare('SELECT adapter_name FROM agent_settings WHERE space_key = ?')
      .get(spaceKey) as { adapter_name?: string } | undefined
    return row?.adapter_name ?? null
  }

  setAgentAdapterName(spaceKey: string, adapterName: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_settings (space_key, adapter_name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(space_key) DO UPDATE SET adapter_name=excluded.adapter_name, updated_at=excluded.updated_at`,
      )
      .run(spaceKey, adapterName, new Date().toISOString())
  }

  private toPage(row: {
    page_id: string
    space_key: string
    path: string
    title: string
    version: number
    parent_id: string | null
    content_hash: string | null
    updated_at: string | null
    synced_at: string
    remote_deleted: number
    base_body: string | null
    base_version: number | null
  }): PageRecord {
    return {
      pageId: row.page_id,
      spaceKey: row.space_key,
      path: row.path,
      title: row.title,
      version: row.version,
      parentId: row.parent_id,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
      syncedAt: row.synced_at,
      remoteDeleted: row.remote_deleted === 1,
      baseBody: row.base_body,
      baseVersion: row.base_version,
    }
  }
}
