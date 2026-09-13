/**
 * electron-builder afterPack 훅 — 배포물 Electron 바이너리의 보안 퓨즈를 켠다.
 * 참조: https://github.com/electron/fuses
 * - RunAsNode·NODE_OPTIONS·inspect 비활성화로 변조 실행 경로 차단
 * - asar 무결성 검증·OnlyLoadAppFromAsar로 코드 변조 차단
 * - asar 무결성은 macOS만 활성화(electron-builder가 Info.plist에 해시를 자동 삽입).
 *   Windows는 해시 삽입이 보장되지 않아 켜면 기동 실패 위험이 있다.
 * - GrantFileProtocolExtraPrivileges는 유지해야 한다: renderer를 file://로 로드하는
 *   electron-vite 기본 구조라 끄면 renderer가 ERR_FILE_NOT_FOUND로 실패한다(검증됨).
 */
const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('electron-builder')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

function executablePath(context) {
  const productName = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName)
  }
  const executableName = context.packager.executableName || productName
  return join(
    context.appOutDir,
    context.electronPlatformName === 'win32' ? `${executableName}.exe` : executableName,
  )
}

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const isDarwin = context.electronPlatformName === 'darwin'
  const flipped = await flipFuses(executablePath(context), {
    version: FuseVersion.V1,
    // macOS는 identity:null(ad-hoc 서명)이므로 바이너리 수정 후 재서명 필요
    resetAdHocDarwinSignature: isDarwin,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: isDarwin,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true, // renderer가 file://로 로드됨(electron-vite 기본) — 끄면 ERR_FILE_NOT_FOUND
  })
  console.log(
    `[afterPack] fuses flipped: ${JSON.stringify(flipped)} (${context.electronPlatformName})`,
  )

  // better-sqlite3 v13 prebuilds가 8개 플랫폼 바이너리를 전부 탑재한다 —
  // 빌드 대상 플랫폼/아키텍처 바이너리만 남겨 산출물을 줄인다(~14MB/아키텍처).
  const platformName =
    context.electronPlatformName === 'win32'
      ? 'win32'
      : context.electronPlatformName === 'darwin'
        ? 'darwin'
        : 'linux'
  const archName =
    context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : 'ia32'
  const keepSuffix = `-${platformName}-${archName}.node`
  const prebuildsDir = join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds',
  )
  if (existsSync(prebuildsDir)) {
    const universal = context.arch === Arch.universal
    for (const entry of readdirSync(prebuildsDir)) {
      if (!entry.endsWith('.node')) continue
      if (universal && entry.includes(`-${platformName}-`)) continue
      if (entry.endsWith(keepSuffix)) continue
      rmSync(join(prebuildsDir, entry))
    }
    console.log(`[afterPack] prebuilds pruned (keep: ${keepSuffix})`)
  }
}
