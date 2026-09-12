/**
 * E2E 골든 패스 러너(AC-1 → AC-4, ef-11) — runbook: scripts/golden-pass.md
 * 전제: CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN 환경변수 +
 *       설치·로그인된 Claude Code.
 * 안전: 대상은 인증 계정의 개인 스페이스 안에 자동 생성되는 전용 테스트 페이지 1건.
 *       기존 페이지는 읽기만 하고 수정하지 않는다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ConfluenceClient } from '../src/core/confluence/client'
import { SyncStateDb } from '../src/core/store/syncState'
import { pullFullSpace, pullSinglePage } from '../src/main/sync/pullService'
import { markdownLineDiff } from '../src/core/push/diff'
import { computeChangeSet } from '../src/core/push/changeSet'
import { dirSafeSpaceKey } from '../src/core/store/workspace'

const baseUrl = process.env.CONFLUENCE_BASE_URL
const email = process.env.CONFLUENCE_EMAIL
const apiToken = process.env.CONFLUENCE_API_TOKEN

if (!baseUrl || !email || !apiToken) {
  console.error('골든 패스에는 CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN 환경변수가 필요합니다')
  process.exit(2)
}

const workspaceRoot = join(process.cwd(), 'golden-pass-workspace')
// 매 실행마다 프리스틱한 워크스페이스 사용(스크래치 전용 디렉터리)
rmSync(workspaceRoot, { recursive: true, force: true })
mkdirSync(join(workspaceRoot, '.sync'), { recursive: true })
const db = new SyncStateDb(join(workspaceRoot, '.sync', 'sync-state.db'))
const client = new ConfluenceClient({ baseUrl, email, apiToken })

const TEST_TITLE = 'Confluence Local Golden Pass Test'

async function main(): Promise<void> {
  // 0. 인증 계정의 개인 스페이스를 샌드박스로 사용(공용 콘텐츠 무영향)
  const meResponse = await fetch(`${baseUrl}/wiki/rest/api/user/current`, {
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}` }
  })
  if (!meResponse.ok) throw new Error(`인증 실패(${meResponse.status}) — 이메일/API 토큰을 확인하세요`)
  const me = (await meResponse.json()) as { accountId?: string }
  const accountId = me.accountId
  if (!accountId) throw new Error('현재 계정 id를 확인할 수 없습니다')
  const personalKey = `~${accountId}`
  const spaces = await client.listAllSpaces()
  const sandbox = spaces.find((space) => space.key === personalKey)
  if (!sandbox) throw new Error(`개인 스페이스(${personalKey})를 찾을 수 없습니다`)
  console.log(`[샌드박스] 개인 스페이스: ${sandbox.name} (${sandbox.key})`)

  // 1. 연결 확인(AC-1a) + 2. 전체 pull(AC-1b, ef-13)
  const pulled = await pullFullSpace({ client, space: sandbox, workspaceRoot, db })
  console.log(`[AC-1] 전체 pull: 페이지 ${pulled.pages}건, 첨부 ${pulled.attachments}건`)

  // 3. 전용 테스트 페이지 생성(매크로 포함 — 캐리어 왕복 검증 겸용)
  const created = await client.createPage({
    spaceId: sandbox.id,
    title: `${TEST_TITLE} ${new Date().toISOString()}`,
    storageValue:
      '<p>골든 패스 초기 본문</p>' +
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">E2E</ac:parameter>' +
      '<ac:rich-text-body><p>이 페이지는 자동 생성된 테스트 페이지입니다.</p></ac:rich-text-body></ac:structured-macro>'
  })
  console.log(`[생성] 테스트 페이지: ${created.pageId} (v${created.version})`)

  // 생성 직후 1페이지만 즉시 반영(전체 pull은 생성 이전 스냅샷이므로)
  await pullSinglePage({
    client,
    space: sandbox,
    workspaceRoot,
    db,
    summary: { id: created.pageId, title: created.title, version: created.version, parentId: created.parentId },
    dir: `spaces/${dirSafeSpaceKey(sandbox.key)}/${created.pageId}-golden`
  })

  // 4. 채팅 → Claude Code 편집(AC-2): 생성된 페이지 파일만 수정 지시
  const pageDir = `spaces/${dirSafeSpaceKey(sandbox.key)}/${created.pageId}-golden`
  const relToRoot = `${pageDir}/index.md`
  const absPath = join(workspaceRoot, relToRoot)
  if (!existsSync(absPath)) throw new Error(`테스트 페이지 파일이 없습니다: ${absPath}`)
  const before = readFileSync(absPath, 'utf8')

  const { ClaudeCodeAdapter } = await import('../src/main/agent/claudeCodeAdapter')
  const adapter = new ClaudeCodeAdapter()
  const handle = adapter.start({
    prompt: `index.md 파일의 마지막에 '## 골든 패스 확인' 문단을 추가해줘. 이 파일 외에는 아무것도 수정하지 마.`,
    cwd: join(workspaceRoot, 'spaces', dirSafeSpaceKey(sandbox.key)),
    timeoutMs: 10 * 60 * 1000
  })
  handle.onEvent((event) => {
    if (event.type === 'text') process.stdout.write(`[에이전트] ${event.value}\n`)
  })
  const terminal = await handle.terminal
  if (terminal !== 'completed') throw new Error(`에이전트 런이 완료되지 않았습니다: ${terminal}`)

  const after = readFileSync(absPath, 'utf8')
  if (!markdownLineDiff(before, after).some((change) => change.type === 'added')) {
    throw new Error('에이전트 실행 후 파일 변경이 없습니다(AC-2 실패)')
  }
  console.log('[AC-2] 로컬 파일 변경 확인')

  // 5. diff 승인(AC-3): 변경 세트 산출 → 스냅샷 캡처(= 자동 골든 패스의 승인)
  const changeset = computeChangeSet(workspaceRoot, db, sandbox.key)
  console.log(`[AC-3] 변경 세트: modified ${changeset.modified.length}, added ${changeset.added.length}`)
  const { captureSnapshot } = await import('../src/core/push/approval')
  const snapshot = captureSnapshot(workspaceRoot, [relToRoot])

  // 6. push(AC-4): 버전 증가 확인
  const { pushApprovedPages } = await import('../src/main/push/pushService')
  const machine = (await import('../src/main/sync/machines')).machineFor(sandbox.key)
  const outcome = await pushApprovedPages({
    client,
    workspaceRoot,
    db,
    machine,
    snapshot,
    approvedPaths: [relToRoot],
    spaceId: sandbox.id
  })
  if (outcome.uploaded.length !== 1 || outcome.failed.length > 0) {
    throw new Error(`push 실패: ${JSON.stringify(outcome)}`)
  }
  const newVersion = outcome.uploaded[0]!.newVersion
  console.log(`[AC-4] push 완료: 새 버전 ${newVersion}`)

  const remote = await client.getPageStorage(created.pageId)
  if (remote.version !== newVersion) throw new Error(`원격 버전 불일치: ${remote.version} != ${newVersion}`)
  console.log(`[AC-4] Confluence 반영 확인: v${remote.version}`)
  console.log('골든 패스 통과 ✅  (AC-1 → AC-4)')
}


main().catch((error: unknown) => {
  console.error('골든 패스 실패:', error instanceof Error ? error.message : error)
  process.exit(1)
})
