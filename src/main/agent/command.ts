import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** macOS GUI 런치 환경 PATH 보완용 후보 경로(F-10). */
const GUI_PATH_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function augmentedGuiPath(current: string | undefined): string {
  const parts = (current ?? '').split(':').filter((p) => p.length > 0)
  for (const candidate of GUI_PATH_CANDIDATES) {
    if (!parts.includes(candidate)) parts.push(candidate)
  }
  return parts.join(':')
}

/**
 * CLI 바이너리 설치 감지(discover용) — 알려진 후보 경로 → 증강 PATH 순으로 찾는다.
 * 스폰 자체는 bare 이름으로 PATH 위임할 수 있지만, 설치 여부를 물을 때는
 * 실제로 실행 파일이 보이는지 확인해야 "미설치"를 거짓 양성 없이 판정할 수 있다.
 */
export function findExecutable(
  name: string,
  candidates: string[] = [],
  exists: (p: string) => boolean = (p) => existsSync(p),
  pathEnv: string | undefined = augmentedGuiPath(process.env.PATH),
): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  // Windows npm 설치는 pi.cmd/.exe 심 링크를 만든다
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe'] : ['']
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    for (const ext of extensions) {
      const probe = join(dir, `${name}${ext}`)
      if (exists(probe)) return probe
    }
  }
  return null
}
