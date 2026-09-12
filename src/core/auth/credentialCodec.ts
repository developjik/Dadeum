/**
 * 자격증명 파일 코덱(계획 §7 — confluence.yaml에는 토큰 흔적 없음).
 * 토큰은 safeStorage로 암호화되어 base64 ciphertext로만 저장되고,
 * 파일에는 baseUrl·email·ciphertext만 존재한다(평문 토큰 금지 — ef-15).
 * encrypt/decrypt는 main의 safeStorage 구현을 주입받는다(테스트 가능).
 */
export interface StoredCredentials {
  baseUrl: string
  email: string
  /** safeStorage 암호문의 base64 표현 — 평문 토큰은 절대 저장하지 않는다 */
  tokenCiphertextBase64: string
  savedAt: string
}

export interface Encryptor {
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
  isEncryptionAvailable(): boolean
}

export function encodeCredentials(stored: StoredCredentials): string {
  return JSON.stringify(stored, null, 2)
}

export function decodeCredentials(raw: string): StoredCredentials {
  const parsed = JSON.parse(raw) as Partial<StoredCredentials>
  if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl.length === 0) {
    throw new Error('자격증명 파일에 baseUrl이 없습니다')
  }
  if (typeof parsed.email !== 'string' || parsed.email.length === 0) {
    throw new Error('자격증명 파일에 email이 없습니다')
  }
  if (typeof parsed.tokenCiphertextBase64 !== 'string' || parsed.tokenCiphertextBase64.length === 0) {
    throw new Error('자격증명 파일에 토큰 암호문이 없습니다')
  }
  if (typeof parsed.savedAt !== 'string') {
    throw new Error('자격증명 파일에 savedAt이 없습니다')
  }
  return parsed as StoredCredentials
}

export function encryptToken(encryptor: Encryptor, apiToken: string): string {
  if (!encryptor.isEncryptionAvailable()) {
    throw new Error('OS 자격증명 저장소(safeStorage)를 사용할 수 없습니다')
  }
  return encryptor.encrypt(apiToken).toString('base64')
}

export function decryptToken(encryptor: Encryptor, tokenCiphertextBase64: string): string {
  return encryptor.decrypt(Buffer.from(tokenCiphertextBase64, 'base64'))
}
