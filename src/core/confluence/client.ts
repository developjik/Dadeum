import { normalizeId } from './id'
import { ConfluenceApiError, type ConfluenceSpace } from './types'

export type { ConfluenceSpace }

import type { Paginated } from './types'

export interface ConfluenceClientOptions {
  /** 예: https://xxx.atlassian.net (trailing slash 허용, 정규화함) */
  baseUrl: string
  email: string
  apiToken: string
  /** 테스트 주입용 fetch 구현(기본: 전역 fetch) */
  fetchImpl?: typeof fetch
  /** 테스트 주입용 대기 함수(기본: setTimeout) */
  sleep?: (ms: number) => Promise<void>
  /** 429 재시도 상한(기본 3) */
  maxRetries?: number
  /** 단일 페이지 최대 개수(Confluence v2 상한 250) */
  pageSize?: number
  /** 페이지네이션 무한 루프 방어 상한 */
  maxPages?: number
  /** 단일 HTTP 요청 타임아웃 ms(기본 30000 — hang 커넥션이 pull/push를 점유하는 것 방지) */
  requestTimeoutMs?: number
}

export interface AuthIdentity {
  baseUrl: string
  email: string
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  // 스킴 없이 호스트만 입력하는 경우(colosseum.atlassian.net)가 흔하므로 https로
  // 보정한다. http 명시 입력은 보정하지 않고 그대로 거부한다(Cloud 전용 https).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(withScheme)) {
    throw new ConfluenceApiError(
      'unexpected',
      `올바르지 않은 사이트 주소: ${baseUrl}(https://xxx.atlassian.net 형식)`,
    )
  }
  return withScheme
}

function buildBasicAuthHeader(email: string, apiToken: string): string {
  // Buffer는 main 프로세스 전용 — 이 클라이언트는 renderer에서 import하지 않는다.
  const encoded = Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')
  return `Basic ${encoded}`
}

/** Retry-After 헤더(초 단위) 파싱 — 비정상 값은 undefined. */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const asDate = Date.parse(header)
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}
/** Retry-After 대기 상한 — 상한 없이 기다리면 상태머신이 수 시간 잠긴다. */
const MAX_RETRY_AFTER_MS = 60_000

/** _links.next 정규화: 전체 URL이면 경로만 추출하고 /wiki 이중 접두사를 제거한다. */
function normalizeCursorPath(next: string): string {
  let path = next.startsWith('http') ? new URL(next).pathname + new URL(next).search : next
  if (path.startsWith('/wiki/')) path = path.slice('/wiki'.length)
  return path
}

export class ConfluenceClient {
  readonly identity: AuthIdentity
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private readonly pageSize: number
  private readonly maxPages: number
  private readonly requestTimeoutMs: number

  constructor(options: ConfluenceClientOptions) {
    this.identity = { baseUrl: normalizeBaseUrl(options.baseUrl), email: options.email }
    this.token = options.apiToken
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.maxRetries = options.maxRetries ?? 3
    this.pageSize = options.pageSize ?? 100
    this.maxPages = options.maxPages ?? 50
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000
  }

  /** 타임아웃이 적용된 fetch — 네트워크 hang이 동기화 전체를 점유하지 않게 한다. */
  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async requestJson<T>(
    path: string,
    init?: { method?: string; body?: string },
  ): Promise<T> {
    const url = `${this.identity.baseUrl}/wiki${path}`
    const headers: Record<string, string> = {
      Authorization: buildBasicAuthHeader(this.identity.email, this.token),
      Accept: 'application/json',
    }
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json'

    let lastError: ConfluenceApiError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response
      try {
        response = await this.fetchWithTimeout(url, { ...init, headers })
      } catch (cause) {
        // 네트워크 계열 오류(타임아웃 abort 포함)도 백오프 재시도 대상(DNS/일시적 단절).
        const aborted = cause instanceof Error && cause.name === 'AbortError'
        lastError = new ConfluenceApiError(
          'network',
          aborted
            ? `요청 시간 초과(${Math.round(this.requestTimeoutMs / 1000)}초): ${path}`
            : `네트워크 오류: ${String(cause)}`,
        )
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt)
          continue
        }
        throw lastError
      }

      if (response.status === 429) {
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get('Retry-After')) ?? 500 * 2 ** attempt
        lastError = new ConfluenceApiError(
          'rate_limited',
          'Confluence 요청 한도 초과(429)',
          429,
          retryAfterMs,
        )
        if (attempt < this.maxRetries) {
          await this.sleep(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS))
          continue
        }
        throw lastError
      }

      if (response.status === 401) {
        throw new ConfluenceApiError(
          'unauthorized',
          '이메일 또는 API 토큰이 올바르지 않습니다(401)',
          401,
        )
      }
      if (response.status === 403) {
        throw new ConfluenceApiError('forbidden', '접근이 거부되었습니다(403)', 403)
      }
      if (response.status === 404) {
        throw new ConfluenceApiError('not_found', '대상을 찾을 수 없습니다(404)', 404)
      }
      if (response.status === 409) {
        // 사전 GET 버전 검사와 PUT 사이에 원격이 바뀐 경우 — 충돌 해결로 보내야 한다.
        throw new ConfluenceApiError('conflict', '원격에서 문서가 변경되었습니다(409)', 409)
      }
      if (response.status >= 500) {
        lastError = new ConfluenceApiError(
          'server',
          `Confluence 서버 오류(${response.status})`,
          response.status,
        )
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt)
          continue
        }
        throw lastError
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw new ConfluenceApiError(
          'unexpected',
          `예상치 못한 응답(${response.status}): ${bodyText.slice(0, 300)}`,
          response.status,
        )
      }
      return (await response.json()) as T
    }
    throw lastError ?? new ConfluenceApiError('unexpected', '재시도 소진')
  }

  /** 바이너리·multipart 요청 공용 재시도(429·5xx·네트워크 — requestJson과 동일 정책). */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: ConfluenceApiError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response
      try {
        response = await this.fetchWithTimeout(url, init)
      } catch (cause) {
        lastError = new ConfluenceApiError('network', `네트워크 오류: ${String(cause)}`)
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt)
          continue
        }
        throw lastError
      }
      if (response.status === 429) {
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get('Retry-After')) ?? 500 * 2 ** attempt
        lastError = new ConfluenceApiError(
          'rate_limited',
          'Confluence 요청 한도 초과(429)',
          429,
          retryAfterMs,
        )
        if (attempt < this.maxRetries) {
          await this.sleep(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS))
          continue
        }
        throw lastError
      }
      if (response.status >= 500) {
        lastError = new ConfluenceApiError(
          'server',
          `Confluence 서버 오류(${response.status})`,
          response.status,
        )
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt)
          continue
        }
        throw lastError
      }
      return response
    }
    throw lastError ?? new ConfluenceApiError('unexpected', '재시도 소진')
  }

  /** 절대 URL 첨부는 연결된 사이트 origin만 허용 — 자격증명이 제3자 origin으로 전송되는 것을 차단. */
  private resolveDownloadUrl(downloadPath: string): string {
    if (!downloadPath.startsWith('http')) {
      return `${this.identity.baseUrl}${downloadPath.startsWith('/wiki') ? '' : '/wiki'}${downloadPath}`
    }
    let target: URL
    try {
      target = new URL(downloadPath)
    } catch {
      throw new ConfluenceApiError('unexpected', `잘못된 첨부 URL: ${downloadPath}`)
    }
    if (target.origin !== new URL(this.identity.baseUrl).origin) {
      throw new ConfluenceApiError(
        'unexpected',
        `연결되지 않은 origin의 첨부 URL입니다: ${target.origin}`,
      )
    }
    return downloadPath
  }

  /** 스페이스 목록 단일 페이지 조회(커서는 응답 _links.next에서 추출한 절대/상대 경로). */
  async listSpacesPage(cursorPath?: string): Promise<Paginated<ConfluenceSpace>> {
    const path = cursorPath ?? `/api/v2/spaces?limit=${this.pageSize}`
    const body = await this.requestJson<Paginated<ConfluenceSpace>>(path)
    return {
      results: body.results.map((space) => ({ ...space, id: normalizeId(space.id) })),
      _links: body._links,
    }
  }

  /** 스페이스 목록 전체 순회(_links.next 커서, maxPages 방어). */
  async listAllSpaces(): Promise<ConfluenceSpace[]> {
    const spaces: ConfluenceSpace[] = []
    let cursorPath: string | undefined
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.listSpacesPage(cursorPath)
      spaces.push(...body.results)
      const next = body._links?.next
      if (!next) return spaces
      cursorPath = normalizeCursorPath(next)
    }
    throw new ConfluenceApiError(
      'unexpected',
      `스페이스 페이지네이션이 ${this.maxPages}페이지를 초과했습니다`,
    )
  }

  /** 연결 검증: 스페이스 1페이지만 조회해 자격증명과 사이트 접근성을 확인한다. */
  async verifyConnection(): Promise<ConfluenceSpace[]> {
    const page = await this.listSpacesPage(`/api/v2/spaces?limit=${this.pageSize}`)
    return page.results
  }

  /** 스페이스의 모든 페이지를 커서 순회로 수집한다(요약: id·title·version). */
  async listAllPagesBySpace(
    spaceId: string,
  ): Promise<Array<{ id: string; title: string; version: number; parentId: string | null }>> {
    const pages: Array<{ id: string; title: string; version: number; parentId: string | null }> = []
    type PageSummaryBody = Paginated<{
      id: string | number
      title: string
      version?: { number?: number | string }
      parentId?: string | number | null
    }>
    let cursorPath: string | undefined = `/api/v2/spaces/${spaceId}/pages?limit=${this.pageSize}`
    for (let page = 0; page < this.maxPages; page++) {
      const path = cursorPath as string
      const body: PageSummaryBody = await this.requestJson<PageSummaryBody>(path)
      for (const item of body.results) {
        pages.push({
          id: normalizeId(item.id),
          title: item.title,
          version: Number(item.version?.number ?? 0),
          parentId: item.parentId == null ? null : normalizeId(item.parentId),
        })
      }
      const next = body._links?.next
      if (!next) return pages
      cursorPath = normalizeCursorPath(next)
    }
    throw new ConfluenceApiError(
      'unexpected',
      `페이지 페이지네이션이 ${this.maxPages}페이지를 초과했습니다`,
    )
  }

  /** 페이지 본문(storage format)과 버전을 조회한다. */
  async getPageStorage(
    pageId: string,
  ): Promise<{ id: string; title: string; version: number; storageValue: string }> {
    const body = await this.requestJson<{
      id: string | number
      title: string
      version?: { number?: number | string }
      body?: { storage?: { value?: string } }
    }>(`/api/v2/pages/${pageId}?body-format=storage`)
    return {
      id: normalizeId(body.id),
      title: body.title,
      version: Number(body.version?.number ?? 0),
      storageValue: body.body?.storage?.value ?? '',
    }
  }

  /**
   * 첨부 목록. v1 REST가 사이트에서 비활성화된 경우(404) v2 엔드포인트로 폴백한다.
   * downloadPath는 _links.download(상대 경로) — downloadAttachment에 그대로 전달.
   */
  async listAttachments(
    pageId: string,
  ): Promise<
    Array<{ id: string; fileName: string; mediaType: string | null; downloadPath: string | null }>
  > {
    try {
      const body = await this.requestJson<{
        results?: Array<{
          id: string | number
          title: string
          metadata?: { mediaType?: { name?: string } }
        }>
      }>(`/rest/api/content/${pageId}/child/attachment?limit=${this.pageSize}`)
      return (body.results ?? []).map((item) => ({
        id: normalizeId(item.id),
        fileName: item.title,
        mediaType: item.metadata?.mediaType?.name ?? null,
        downloadPath: `/wiki/rest/api/content/${pageId}/child/attachment/${normalizeId(item.id)}/download`,
      }))
    } catch (cause) {
      if (!(cause instanceof ConfluenceApiError) || cause.status !== 404) throw cause
      const body = await this.requestJson<{
        results?: Array<{
          id: string | number
          title?: string
          fileId?: string
          mediaType?: string
          _links?: { download?: string }
        }>
      }>(`/api/v2/pages/${pageId}/attachments?limit=${this.pageSize}`)
      return (body.results ?? []).map((item) => ({
        id: normalizeId(item.id),
        fileName: item.title ?? item.fileId ?? 'attachment',
        mediaType: item.mediaType ?? null,
        downloadPath: item._links?.download ?? null,
      }))
    }
  }

  /** 페이지 생성(v2, AC-9). 응답 id·version을 문자열/숫자로 정규화해 반환. */
  async createPage(request: {
    spaceId: string
    parentId?: string
    title: string
    storageValue: string
  }): Promise<{ pageId: string; title: string; version: number; parentId: string | null }> {
    const payload: Record<string, unknown> = {
      spaceId: request.spaceId,
      status: 'current',
      title: request.title,
      body: { representation: 'storage', value: request.storageValue },
    }
    if (request.parentId) payload.parentId = request.parentId
    const body = await this.requestJson<{
      id: string | number
      title: string
      version?: { number?: number | string }
      parent_id?: string | number
    }>('/api/v2/pages', { method: 'POST', body: JSON.stringify(payload) })
    return {
      pageId: normalizeId(body.id),
      title: body.title,
      version: Number(body.version?.number ?? 1),
      parentId: body.parent_id == null ? null : normalizeId(body.parent_id),
    }
  }

  /**
   * 페이지 수정(v2 — 요청 버전 명시, 충돌 시 Confluence가 거부).
   * parentId를 넘기면 페이지 이동(부모 변경)도 반영한다. 원격 루트로 이동은
   * parentType 'space' + parentId = spaceId로 표현한다.
   */
  async updatePage(request: {
    pageId: string
    currentVersion: number
    title: string
    storageValue: string
    parentId?: string | null
    parentType?: 'page' | 'space'
  }): Promise<{ pageId: string; title: string; version: number }> {
    const payload: Record<string, unknown> = {
      id: request.pageId,
      status: 'current',
      title: request.title,
      body: { representation: 'storage', value: request.storageValue },
      version: { number: request.currentVersion + 1 },
    }
    if (request.parentId !== undefined) {
      payload.parentId = request.parentId
      payload.parentType = request.parentType ?? 'page'
    }
    const body = await this.requestJson<{
      id: string | number
      title: string
      version?: { number?: number | string }
    }>(`/api/v2/pages/${request.pageId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    return {
      pageId: normalizeId(body.id),
      title: body.title,
      version: Number(body.version?.number ?? 0),
    }
  }

  /**
   * 페이지 콘텐츠 속성 설정(v2). REST로 생성한 페이지는 legacy editor로 취급될 수
   * 있는데, 이 경우 사용자가 브라우저에서 저장할 때 첨부 참조가 UNKNOWN_ATTACHMENT로
   * 재작성되는 결함이 알려져 있다 — editor=v2 속성으로 새 편집기 취급을 보장한다.
   */
  async setPageContentProperty(pageId: string, key: string, value: string): Promise<void> {
    await this.requestJson<unknown>(`/api/v2/pages/${pageId}/content-properties`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    })
  }

  /**
   * 증분 폴링용: 특정 시각 이후 수정된 페이지 id 목록(v1 CQL 검색, 커서 순회).
   * 단일 페이지 조회로 두면 pageSize 초과 변경분이 누락되므로 _links.next를 순회한다.
   */
  async listPageIdsModifiedSince(spaceKey: string, sinceIso: string): Promise<string[]> {
    const escapedKey = spaceKey.replace(/"/g, '\\"')
    const cql = `type=page AND space="${escapedKey}" AND lastmodified > "${sinceIso}"`
    const ids: string[] = []
    const seen = new Set<string>()
    let cursorPath: string | undefined =
      `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${this.pageSize}`
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.requestJson<{
        results?: Array<{ content?: { id?: string | number } }>
        _links?: { next?: string }
      }>(cursorPath)
      for (const item of body.results ?? []) {
        const id = item.content?.id
        if (id === undefined) continue
        const normalized = normalizeId(id)
        if (!seen.has(normalized)) {
          seen.add(normalized)
          ids.push(normalized)
        }
      }
      const next = body._links?.next
      if (!next) return ids
      cursorPath = normalizeCursorPath(next)
    }
    throw new ConfluenceApiError(
      'unexpected',
      `증분 검색 페이지네이션이 ${this.maxPages}페이지를 초과했습니다`,
    )
  }

  /** 첨부 업로드(v1 — 동명 재업로드 시 버전 갱신, X-Atlassian-Token 필수). */
  async uploadAttachment(
    pageId: string,
    fileName: string,
    content: Buffer,
    mediaType: string,
  ): Promise<{ id: string }> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(content)], { type: mediaType }), fileName)
    const response = await this.fetchWithRetry(
      `${this.identity.baseUrl}/wiki/rest/api/content/${pageId}/child/attachment`,
      {
        method: 'POST',
        headers: {
          Authorization: buildBasicAuthHeader(this.identity.email, this.token),
          'X-Atlassian-Token': 'no-check',
        },
        body: form,
      },
    )
    if (!response.ok) {
      throw new ConfluenceApiError(
        'unexpected',
        `첨부 업로드 실패(${response.status})`,
        response.status,
      )
    }
    const body = (await response.json()) as { results?: Array<{ id: string | number }> }
    const first = body.results?.[0]
    if (!first) throw new ConfluenceApiError('unexpected', '첨부 업로드 응답에 결과가 없습니다')
    return { id: normalizeId(first.id) }
  }

  /** 첨부 바이너리 다운로드(downloadPath: listAttachments가 반환한 상대 경로). */
  async downloadAttachment(downloadPath: string): Promise<ArrayBuffer> {
    const url = this.resolveDownloadUrl(downloadPath)
    const headers = { Authorization: buildBasicAuthHeader(this.identity.email, this.token) }
    const response = await this.fetchWithRetry(url, { headers })
    if (!response.ok) {
      throw new ConfluenceApiError(
        'unexpected',
        `첨부 다운로드 실패(${response.status})`,
        response.status,
      )
    }
    return response.arrayBuffer()
  }

  /**
   * 첨부 삭제(v1 — 첨부도 content이므로 content id로 삭제한다).
   * 로컬에서 삭제된 첨부를 원격에서도 정리할 때 사용한다.
   */
  async deleteAttachment(attachmentId: string): Promise<void> {
    const response = await this.fetchWithRetry(
      `${this.identity.baseUrl}/wiki/rest/api/content/${attachmentId}`,
      {
        method: 'DELETE',
        headers: { Authorization: buildBasicAuthHeader(this.identity.email, this.token) },
      },
    )
    if (!response.ok && response.status !== 404) {
      throw new ConfluenceApiError(
        'unexpected',
        `첨부 삭제 실패(${response.status})`,
        response.status,
      )
    }
  }
}
