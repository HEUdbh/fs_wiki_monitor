import type { CloudflareBindings } from '../bindings'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function encryptionKey(env: CloudflareBindings): Promise<CryptoKey> {
  const isLocal = env.APP_ORIGIN.startsWith('http://localhost') || env.APP_ORIGIN.startsWith('http://127.0.0.1')
  if (!env.TOKEN_ENCRYPTION_KEY && !isLocal) throw new Error('生产环境缺少 TOKEN_ENCRYPTION_KEY')
  const source = env.TOKEN_ENCRYPTION_KEY || env.SESSION_SIGNING_KEY || 'local-development-only'
  let raw: Uint8Array
  try {
    raw = base64ToBytes(source)
  } catch {
    raw = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(source)))
  }
  if (raw.byteLength !== 32) {
    raw = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(raw)))
  }
  return crypto.subtle.importKey('raw', asArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptJson(env: CloudflareBindings, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    await encryptionKey(env),
    encoder.encode(JSON.stringify(value)),
  )
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`
}

export async function decryptJson<T>(env: CloudflareBindings, value: string): Promise<T> {
  const [version, iv, payload] = value.split('.')
  if (version !== 'v1' || !iv || !payload) throw new Error('不支持的加密记录格式')
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(base64ToBytes(iv)) },
    await encryptionKey(env),
    asArrayBuffer(base64ToBytes(payload)),
  )
  return JSON.parse(decoder.decode(decrypted)) as T
}

export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}
