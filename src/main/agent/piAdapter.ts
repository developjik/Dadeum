import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentAdapter,
  type AgentCapabilities,
  type AgentInstallation,
  type AgentRunHandle,
  type AgentRunRequest,
  DEFAULT_AGENT_TIMEOUT_MS,
} from '../../core/agent/types'
import { type AgentProcess, type SpawnFn, startCliRun } from './cliProcessRun'
import { augmentedGuiPath, findExecutable } from './command'
import { PiJsonParser } from './piJson'

// 테스트·레지스트리가 piAdapter에서 가져올 수 있게 재수출한다
export type { AgentProcess, SpawnFn }

/**
 * 읽기 전용 도구 세트 — pi 기본 도구의 bash를 의도적으로 제외한다.
 * 감사 런은 문서(신뢰 불가 입력)의 지시로 무엇도 실행하면 안 된다.
 */
const PI_READ_TOOLS = 'read,grep,find,ls'

/**
 * 편집 런 도구 세트 — bash 제외(Claude 어댑터와 동일한 정책).
 * pi는 Edit/Write의 경로 스코핑이 없으므로 워크스페이스 밖 쓰기 차단은
 * AGENTS.md 규약 + 사용자 검토(변경 감사 게이트)가 담당한다(capabilities 참조).
 */
const PI_WRITE_TOOLS = 'read,grep,find,ls,edit,write'

export function resolvePiCommand(
  candidates: string[] = defaultPiCandidates(),
  exists: (p: string) => boolean = (p) => existsSync(p),
): string {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return 'pi' // PATH 위임
}

/** npm/bun/homebrew 관습 경로 — PATH 스캔은 findExecutable이 보완한다. */
function defaultPiCandidates(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    join(home, '.bun', 'bin', 'pi'),
    join(home, '.local', 'bin', 'pi'),
  ]
}

export function buildPiArgs(sessionId: string | undefined, readOnly = false): string[] {
  // pi는 `--mode json "프롬프트"`로 1회성 NDJSON 실행을 한다(문서화된 비대화 형태).
  // 도구는 allowlist로 좁힌다(-t). 감사 런은 resume하지 않는다(편집 대화 격리).
  const args = ['--mode', 'json', '-t', readOnly ? PI_READ_TOOLS : PI_WRITE_TOOLS]
  if (!readOnly && sessionId) args.push('--resume', sessionId)
  return args // 프롬프트는 positional 인자로 전달
}

export class PiAdapter implements AgentAdapter {
  readonly name = 'pi'

  private readonly spawnImpl: SpawnFn

  constructor(options?: { spawnImpl?: SpawnFn }) {
    this.spawnImpl =
      options?.spawnImpl ??
      ((command, args, opts) => nodeSpawn(command, args, opts) as unknown as AgentProcess)
  }

  discover(): AgentInstallation | null {
    const command = findExecutable('pi', defaultPiCandidates())
    return command ? { command } : null
  }

  capabilities(): AgentCapabilities {
    // --resume/--continue 세션 연속과 JSON 스트리밍은 지원하지만,
    // Edit/Write의 디렉터리 스코핑은 없다 — 경로 제약은 규약·감사로 degradation한다.
    return {
      supportsResume: true,
      supportsScopedWrite: false,
      supportsJsonReview: true,
      supportsStreaming: true,
    }
  }

  start(request: AgentRunRequest): AgentRunHandle {
    // 파서가 줄 상태를 추적하므로 런마다 새 인스턴스를 쓴다
    const parser = new PiJsonParser()
    return startCliRun({
      command: resolvePiCommand(),
      args: buildPiArgs(request.sessionId, request.readOnly === true),
      cwd: request.cwd,
      env: { ...process.env, PATH: augmentedGuiPath(process.env.PATH) },
      timeoutMs: request.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      spawnImpl: this.spawnImpl,
      prompt: { via: 'arg', text: request.prompt },
      parseLine: (line) => parser.feed(line),
      isResultError: (event) => event.type === 'result' && event.isError,
    })
  }
}
