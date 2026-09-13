import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from './client'

/**
 * 클라이언트 증분·타임아웃 회귀(P1):
 * - listPageIdsModifiedSince는 커서를 순회한다(pageSize 초과 변경분 누락 방지)
 * - CQL에 스페이스 키를 안전하게 보간한다(따옴표 이스케이프)
 * - hang 커넥션은 타임아웃으로 끊고 네트워크 오류로 분류한다
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('listPageIdsModifiedSince', () => {
  it('_links.next 커서를 끝까지 순회한다', async () => {
    const requested: string[] = []
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      sleep: () => Promise.resolve(),
      fetchImpl: (async (input: Request | string | URL) => {
        const url = String(input)
        requested.push(url)
        if (url.includes('cursor=2')) {
          return jsonResponse({
            results: [{ content: { id: 2 } }],
            _links: {},
          })
        }
        return jsonResponse({
          results: [{ content: { id: '1' } }],
          _links: { next: '/rest/api/search?cursor=2' },
        })
      }) as unknown as typeof fetch,
    })

    const ids = await client.listPageIdsModifiedSince('DEV', '2026-09-13T00:00:00Z')
    expect(ids).toEqual(['1', '2'])
    expect(requested).toHaveLength(2)
    // 커서 경로가 그대로 요청되는지(_links.next 위임)
    expect(requested[1]).toContain('cursor=2')
  })

  it('스페이스 키의 따옴표를 이스케이프해 CQL을 보간한다', async () => {
    let capturedUrl = ''
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      sleep: () => Promise.resolve(),
      fetchImpl: (async (input: Request | string | URL) => {
        capturedUrl = String(input)
        return jsonResponse({ results: [] })
      }) as unknown as typeof fetch,
    })

    await client.listPageIdsModifiedSince('DEV"INJECTION', '2026-09-13T00:00:00Z')
    const cql = decodeURIComponent(capturedUrl.split('cql=')[1]!.split('&')[0]!)
    expect(cql).toContain('space="DEV\\"INJECTION"')
  })
})

describe('요청 타임아웃', () => {
  it('응답이 hang되면 abort하고 네트워크 오류(시간 초과)로 분류한다', async () => {
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      maxRetries: 0,
      requestTimeoutMs: 20,
      sleep: () => Promise.resolve(),
      fetchImpl: ((_input: Request | string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }) as unknown as typeof fetch,
    })

    await expect(client.listSpacesPage()).rejects.toThrow(/요청 시간 초과/)
  })
})
