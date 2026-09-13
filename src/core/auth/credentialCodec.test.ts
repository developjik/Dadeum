import { describe, expect, it } from 'vitest'
import {
  decodeCredentials,
  decryptToken,
  type Encryptor,
  encodeCredentials,
  encryptToken,
} from './credentialCodec'

/** 테스트용 대칭 암호기(실제 safeStorage는 main에서 주입). */
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(`enc:${plaintext.split('').reverse().join('')}`),
  decrypt: (ciphertext) =>
    ciphertext.toString('utf8').replace(/^enc:/, '').split('').reverse().join(''),
}

describe('자격증명 코덱', () => {
  it('토큰을 암호화해 저장하고 복호화로 되돌린다', () => {
    const ciphertext = encryptToken(fakeEncryptor, 'ATATT-secret-token')
    const stored = {
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      tokenCiphertextBase64: ciphertext,
      savedAt: '2026-09-12T00:00:00.000Z',
    }
    const round = JSON.parse(encodeCredentials(stored)) as typeof stored
    expect(decryptToken(fakeEncryptor, round.tokenCiphertextBase64)).toBe('ATATT-secret-token')
  })

  it('저장 형식 어디에도 평문 토큰이 나타나지 않는다', () => {
    const ciphertext = encryptToken(fakeEncryptor, 'PLAINTEXT-TOKEN-VALUE')
    const raw = encodeCredentials({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      tokenCiphertextBase64: ciphertext,
      savedAt: '2026-09-12T00:00:00.000Z',
    })
    expect(raw).not.toContain('PLAINTEXT-TOKEN-VALUE')
  })

  it('손상된 파일은 명확한 오류로 거부한다', () => {
    expect(() => decodeCredentials('{}')).toThrow(/baseUrl/)
    expect(() => decodeCredentials('{"baseUrl":"https://x.atlassian.net"}')).toThrow(/email/)
    expect(() => decodeCredentials('not json at all')).toThrow()
  })

  it('암호화 불가 환경에서는 저장을 거부한다', () => {
    const unavailable: Encryptor = { ...fakeEncryptor, isEncryptionAvailable: () => false }
    expect(() => encryptToken(unavailable, 'token')).toThrow(/safeStorage/)
  })
})
