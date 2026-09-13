import { describe, expect, it, vi } from 'vitest'
import { ConfluenceClient, parseRetryAfterMs } from './client'
import { ConfluenceApiError } from './types'

interface MockResponseInit {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function jsonResponse(init: MockResponseInit): Response {
  return new Response(init.body === undefined ? undefined : JSON.stringify(init.body), {
    status: init.status,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

function spacesPage(ids: string[], next?: string) {
  return {
    results: ids.map((id) => ({ id, key: `K${id}`, name: `스페이스 ${id}` })),
    _links: next ? { next } : {},
  }
}

const instantSleep = () => Promise.resolve()

describe('ConfluenceClient', () => {
  it('baseUrl을 정규화하고 trailing slash를 허용한다', () => {
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net/',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl: async () => jsonResponse({ status: 200, body: spacesPage(['1']) }),
    })
    expect(client.identity.baseUrl).toBe('https://acme.atlassian.net')
  })

  it('http 사이트 주소를 거부한다(Server/DC 방지)', () => {
    expect(
      () =>
        new ConfluenceClient({
          baseUrl: 'http://confluence.internal',
          email: 'a@b.c',
          apiToken: 't',
        }),
    ).toThrow(/https/)
  })

  it('_links.next 커서로 모든 스페이스 페이지를 순회한다', async () => {
    const requestedUrls: string[] = []
    const fetchImpl = vi.fn(async (input: Request | string | URL) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.endsWith('limit=2'))
        return jsonResponse({
          status: 200,
          body: spacesPage(['1', '2'], '/wiki/api/v2/spaces?limit=2&cursor=abc'),
        })
      if (url.includes('cursor=abc'))
        return jsonResponse({
          status: 200,
          body: spacesPage(['3'], '/wiki/api/v2/spaces?limit=2&cursor=def'),
        })
      return jsonResponse({ status: 200, body: spacesPage(['4']) })
    })
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      pageSize: 2,
      sleep: instantSleep,
    })

    const spaces = await client.listAllSpaces()
    expect(spaces.map((s) => s.id)).toEqual(['1', '2', '3', '4'])
    expect(requestedUrls.length).toBe(3)
    expect(requestedUrls[0]).toContain('/wiki/api/v2/spaces?limit=2')
  })

  it('페이지네이션 무한 루프를 maxPages로 방어한다', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 200,
        body: spacesPage(['1'], '/wiki/api/v2/spaces?limit=2&cursor=loop'),
      }),
    )
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      maxPages: 5,
      sleep: instantSleep,
    })
    await expect(client.listAllSpaces()).rejects.toThrow(/페이지네이션/)
    expect(fetchImpl).toHaveBeenCalledTimes(5)
  })

  it('429 응답에서 Retry-After를 존중해 재시도 후 성공한다', async () => {
    const sleeps: number[] = []
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls <= 2)
        return jsonResponse({
          status: 429,
          body: { message: 'slow down' },
          headers: { 'Retry-After': '2' },
        })
      return jsonResponse({ status: 200, body: spacesPage(['7']) })
    })
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    const spaces = await client.listSpacesPage()
    expect(spaces.results[0]?.id).toBe('7')
    expect(sleeps).toEqual([2000, 2000])
    expect(calls).toBe(3)
  })

  it('429가 재시도 상한을 넘으면 rate_limited 오류를 던진다', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: 429, body: {}, headers: { 'Retry-After': '0' } }),
    )
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      sleep: instantSleep,
      maxRetries: 2,
    })
    await expect(client.listSpacesPage()).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('401은 재시도 없이 unauthorized로 즉시 실패한다', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 401, body: {} }))
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 'wrong',
      fetchImpl,
      sleep: instantSleep,
    })
    await expect(client.listSpacesPage()).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('숫자로 반환된 id도 문자열로 정규화한다(F-9)', async () => {
    // 실제 Confluence v2는 id를 문자열로 반환한다. 2^53 초과 숫자는 JSON.parse
    // 시점에 이미 정밀도를 잃으므로(되돌릴 수 없음), 클라이언트의 계약은
    // "숫자가 오면 문자열화한다"이고 안전한 경계값(2^53-1)으로 검증한다.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 200,
        body: {
          results: [{ id: 9007199254740991, key: 'BIG', name: '정밀도 경계 스페이스' }],
          _links: {},
        },
      }),
    )
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      sleep: instantSleep,
    })
    const spaces = await client.listSpacesPage()
    expect(typeof spaces.results[0]?.id).toBe('string')
    expect(spaces.results[0]?.id).toBe('9007199254740991')
  })

  it('네트워크 실패는 백오프 재시도 후 network 오류가 된다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      sleep: instantSleep,
      maxRetries: 1,
    })
    await expect(client.listSpacesPage()).rejects.toMatchObject({ kind: 'network' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('기본 인증 헤더가 이메일과 토큰으로 구성된다', async () => {
    let authHeader: string | undefined
    const fetchImpl = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      authHeader = ((init?.headers ?? {}) as Record<string, string>).Authorization
      return jsonResponse({ status: 200, body: spacesPage(['1']) })
    })
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      fetchImpl,
      sleep: instantSleep,
    })
    await client.listSpacesPage()
    expect(authHeader).toBe(`Basic ${Buffer.from('dev@acme.io:tok').toString('base64')}`)
  })

  it('verifyConnection은 스페이스 목록으로 연결을 검증한다', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 200, body: spacesPage(['1', '2']) }))
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl,
      sleep: instantSleep,
    })
    const spaces = await client.verifyConnection()
    expect(spaces).toHaveLength(2)
  })

  it('parseRetryAfterMs는 초/날짜/비정상 값을 처리한다', () => {
    expect(parseRetryAfterMs('3')).toBe(3000)
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('garbage')).toBeUndefined()
  })
})

describe('ConfluenceApiError', () => {
  it('오류 종류와 상태를 보존한다', () => {
    const err = new ConfluenceApiError('not_found', '없음', 404)
    expect(err.kind).toBe('not_found')
    expect(err.status).toBe(404)
    expect(err.name).toBe('ConfluenceApiError')
  })
})
