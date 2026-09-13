import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, crashReporter } from 'electron'

/**
 * 메인 프로세스 진단 기반(로컬 전용 — 외부 전송 없음).
 * - crashReporter: 로컬 덤프만 남긴다(uploadToServer 없이 크래시 시 OS 덤프 디렉터리에 기록).
 * - uncaughtException/unhandledRejection: 핸들러 밖 경로(폴링 루프·자식 프로세스 추적 등)의
 *   예외가 조용히 사라지지 않게 로그 파일에 남긴다.
 * - 일별 로그 파일(userData/logs/main.log), 5MB 초과 시 .1로 한 세대 롤링.
 */

const MAX_LOG_BYTES = 5 * 1024 * 1024

let logFilePath: string | null = null

function resolveLogFilePath(): string {
  if (logFilePath === null) {
    const logsDir = join(app.getPath('userData'), 'logs')
    mkdirSync(logsDir, { recursive: true })
    logFilePath = join(logsDir, 'main.log')
  }
  return logFilePath
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return
    renameSync(path, `${path}.1`) // 한 세대만 유지 — 무한 증가 방지
  } catch {
    // 롤링 실패는 기록 자체를 막지 않는다
  }
}

function appendDiagnosticLog(kind: string, detail: unknown): void {
  try {
    const path = resolveLogFilePath()
    rotateIfNeeded(path)
    const message =
      detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail)
    appendFileSync(path, `[${new Date().toISOString()}] [${kind}] ${message}\n`, 'utf8')
  } catch {
    // 로그 실패로 앱을 죽이지 않는다
  }
}

export function initDiagnostics(): void {
  // submitURL 없이 업로드하지 않는 로컬 전용 모드 — 기동 준비 전에 호출해야 한다.
  crashReporter.start({ uploadToServer: false })
  process.on('uncaughtException', (error) => {
    appendDiagnosticLog('uncaughtException', error)
  })
  process.on('unhandledRejection', (reason) => {
    appendDiagnosticLog('unhandledRejection', reason)
  })
  appendDiagnosticLog('startup', `${app.getName()} ${app.getVersion()} (${process.platform})`)
}
