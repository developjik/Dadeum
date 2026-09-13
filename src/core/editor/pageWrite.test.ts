import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { carrierFence, contentHash } from '../converter/carriers'
import { renderPageFile } from '../store/workspace'
import { writePageBody } from './pageWrite'

const XML =
  '<ac:structured-macro ac:name="info"><ac:rich-text-body>안내</ac:rich-text-body></ac:structured-macro>'
const CARRIER = carrierFence('info', contentHash(XML), XML)

function makeWorkspace(): { root: string; pagePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'cl-edit-'))
  const pagePath = 'spaces/DEV/guide/index.md'
  const abs = join(root, pagePath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(
    abs,
    renderPageFile(
      {
        pageId: '1001',
        spaceKey: 'DEV',
        title: '가이드',
        version: 3,
        parentId: null,
        url: 'https://acme.atlassian.net/wiki/spaces/DEV/pages/1001',
        updatedAt: '2026-01-01T00:00:00Z',
        syncedAt: '2026-01-02T00:00:00Z',
      },
      `시작\n\n${CARRIER}\n\n끝`,
    ),
    'utf8',
  )
  return { root, pagePath }
}

const workspaces: string[] = []
afterEach(() => {
  while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true })
})

describe('writePageBody', () => {
  it('본문을 교체하고 frontmatter를 그대로 보존한다', () => {
    const { root, pagePath } = makeWorkspace()
    workspaces.push(root)
    const before = readFileSync(join(root, pagePath), 'utf8')
    const frontmatterBefore = before.split('\n---\n')[0]

    const result = writePageBody(root, pagePath, '새 본문입니다.')

    const after = readFileSync(join(root, pagePath), 'utf8')
    expect(after.startsWith(`${frontmatterBefore}\n---\n`)).toBe(true)
    expect(after.endsWith('새 본문입니다.')).toBe(true)
    expect(result).toMatchObject({ pageId: '1001', title: '가이드', version: 3 })
    expect(result.markdown).toBe('새 본문입니다.')
  })

  it('캐리어를 원본 그대로 유지한 저장은 성공한다', () => {
    const { root, pagePath } = makeWorkspace()
    workspaces.push(root)
    const result = writePageBody(root, pagePath, `서두\n\n${CARRIER}\n\n맺음`)
    expect(result.markdown).toContain(CARRIER)
  })

  it('캐리어 내용이 변질된 저장은 거부한다(push 게이트와 동일 검증)', () => {
    const { root, pagePath } = makeWorkspace()
    workspaces.push(root)
    const tampered = CARRIER.replace('안내', '변조')
    expect(() => writePageBody(root, pagePath, tampered)).toThrow(/캐리어 무결성/)
    // 거부 시 파일은 원본 그대로다
    expect(readFileSync(join(root, pagePath), 'utf8')).toContain(CARRIER)
  })

  it('캐리어 삭제는 허용한다 — push 변환과 같이 매크로 제거는 합법 편집이다', () => {
    const { root, pagePath } = makeWorkspace()
    workspaces.push(root)
    expect(() => writePageBody(root, pagePath, '매크로를 지운 문서')).not.toThrow()
  })

  it('동기 대상이 아닌 경로는 거부한다', () => {
    const { root } = makeWorkspace()
    workspaces.push(root)
    expect(() => writePageBody(root, '../escape.md', 'x')).toThrow(/동기 대상이 아닌 경로/)
    expect(() => writePageBody(root, 'confluence.yaml', 'x')).toThrow(/동기 대상이 아닌 경로/)
  })

  it('없는 페이지 파일은 오류로 거부한다', () => {
    const { root } = makeWorkspace()
    workspaces.push(root)
    expect(() => writePageBody(root, 'spaces/DEV/none/index.md', 'x')).toThrow(/찾을 수 없습니다/)
  })

  it('비정상 대형 본문은 거부한다', () => {
    const { root, pagePath } = makeWorkspace()
    workspaces.push(root)
    expect(() => writePageBody(root, pagePath, 'x'.repeat(2_000_001))).toThrow(/너무 깁니다/)
  })
})
