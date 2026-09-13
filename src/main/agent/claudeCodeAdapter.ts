import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  type AgentAdapter,
  type AgentCapabilities,
  type AgentRunHandle,
  type AgentRunRequest,
  DEFAULT_AGENT_TIMEOUT_MS,
} from '../../core/agent/types'
import { type AgentProcess, type SpawnFn, startCliRun } from './cliProcessRun'
import { augmentedGuiPath, findExecutable } from './command'
import { parseStreamJsonLine } from './streamJson'

export { augmentedGuiPath } from './command'
// 하위 호환 재수출 — 기존 테스트·레지스트리가 claudeCodeAdapter에서 가져온다
export type { AgentProcess, SpawnFn }

export function resolveClaudeCommand(
  candidates: string[] = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  exists: (p: string) => boolean = (p) => existsSync(p),
): string {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return 'claude' // PATH 위임
}

export function buildClaudeArgs(
  sessionId: string | undefined,
  spaceRoot?: string,
  readOnly = false,
): string[] {
  if (readOnly) {
    // 감사 런: 쓰기 도구 자체를 부여하지 않는다 — 문서 내용(신뢰 불가 입력)이
    // 무슨 지시를 심어도 워크스페이스를 바꿀 수 없다. 세션 resume도 하지 않는다.
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Read,Glob,Grep',
    ]
    return args
  }
  // 파일 수정 도구는 스페이스 루트로 경로 스코프 — 프롬프트 인젝션에 의한
  // 워크스페이스 밖 쓰기를 차단한다(읽기 도구는 CLI 기본 정책을 따른다).
  const writeScope = spaceRoot ? scopedToolRule(spaceRoot) : ''
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    `Read,Glob,Grep,Edit${writeScope},Write${writeScope}`,
  ]
  if (sessionId) args.push('--resume', sessionId)
  return args // 프롬프트는 stdin으로 전달
}

/** Claude Code 경로 규칙 — 절대 경로는 `//` 접두(gitignore 방식). */
function scopedToolRule(spaceRoot: string): string {
  const posix = spaceRoot.replace(/\\/g, '/')
  return `(//${posix.replace(/^\/+/, '')}/**)`
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code'

  private readonly spawnImpl: SpawnFn

  constructor(options?: { spawnImpl?: SpawnFn }) {
    this.spawnImpl =
      options?.spawnImpl ??
      ((command, args, opts) => nodeSpawn(command, args, opts) as unknown as AgentProcess)
  }

  discover() {
    const command = findExecutable('claude', ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
    return command ? { command } : null
  }

  capabilities(): AgentCapabilities {
    // --resume 세션 연속, 경로 스코핑된 Edit/Write, stream-json 결과 파싱 모두 지원
    return {
      supportsResume: true,
      supportsScopedWrite: true,
      supportsJsonReview: true,
      supportsStreaming: true,
    }
  }

  start(request: AgentRunRequest): AgentRunHandle {
    return startCliRun({
      command: resolveClaudeCommand(),
      args: buildClaudeArgs(request.sessionId, request.cwd, request.readOnly === true),
      cwd: request.cwd,
      env: { ...process.env, PATH: augmentedGuiPath(process.env.PATH) },
      timeoutMs: request.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      spawnImpl: this.spawnImpl,
      // claude -p는 stdin/positional 양쪽 지원, 파이프 환경에서 stdin이 안전하다
      prompt: { via: 'stdin', text: request.prompt },
      parseLine: parseStreamJsonLine,
      isResultError: (event) => event.type === 'result' && event.isError,
    })
  }
}
