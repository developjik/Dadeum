import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  decodeCredentials,
  decryptToken,
  type Encryptor,
  encodeCredentials,
  encryptToken,
  type StoredCredentials,
} from '../core/auth/credentialCodec'
import { ConfluenceClient } from '../core/confluence/client'

/** safeStorage 어댑터(계획 §7 — 토큰은 OS 키체인 기반 암호화로만 저장). */
const safeStorageEncryptor: Encryptor = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
}

function credentialsFilePath(): string {
  return join(app.getPath('userData'), 'auth.json')
}

function loadStoredCredentials(): StoredCredentials | null {
  const path = credentialsFilePath()
  if (!existsSync(path)) return null
  try {
    return decodeCredentials(readFileSync(path, 'utf8'))
  } catch {
    // 손상된 자격증명 파일은 연결 해제 상태로 시작(재연결 시 덮어씀).
    return null
  }
}

export function saveCredentials(
  baseUrl: string,
  email: string,
  apiToken: string,
): StoredCredentials {
  const stored: StoredCredentials = {
    baseUrl,
    email,
    tokenCiphertextBase64: encryptToken(safeStorageEncryptor, apiToken),
    savedAt: new Date().toISOString(),
  }
  writeFileSync(credentialsFilePath(), encodeCredentials(stored), { encoding: 'utf8', mode: 0o600 })
  return stored
}

export function clearCredentials(): void {
  rmSync(credentialsFilePath(), { force: true })
}

/** 저장된 자격증명으로 클라이언트를 만든다. 없으면 null. */
export function createClientFromStoredCredentials(): ConfluenceClient | null {
  const stored = loadStoredCredentials()
  if (!stored) return null
  let apiToken: string
  try {
    apiToken = decryptToken(safeStorageEncryptor, stored.tokenCiphertextBase64)
  } catch {
    return null
  }
  return new ConfluenceClient({ baseUrl: stored.baseUrl, email: stored.email, apiToken })
}

export interface ConnectionStatus {
  connected: boolean
  baseUrl?: string
  email?: string
}

export function getConnectionStatus(): ConnectionStatus {
  const stored = loadStoredCredentials()
  if (!stored) return { connected: false }
  // 파일이 있어도 토큰 복호화가 실패하면 미연결로 판정한다 —
  // '연결됨'으로 보이다가 모든 API가 실패하는 상태 불일치를 막는다.
  try {
    decryptToken(safeStorageEncryptor, stored.tokenCiphertextBase64)
  } catch {
    return { connected: false }
  }
  return { connected: true, baseUrl: stored.baseUrl, email: stored.email }
}
