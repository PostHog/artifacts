const encoder = new TextEncoder()

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 22 base62 characters ≈ 131 bits of entropy: unguessable and not enumerable. */
export function randomId(length = 22): string {
    const out: string[] = []
    // Rejection sampling keeps the distribution uniform (248 = 62 * 4).
    while (out.length < length) {
        for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
            if (byte < 248 && out.length < length) out.push(BASE62[byte % 62]!)
        }
    }
    return out.join('')
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    let binary = ''
    for (const b of arr) binary += String.fromCharCode(b)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Derives an independent secret for a third-party consumer (e.g. the OAuth library) from SESSION_SECRET. */
export async function deriveSecret(secret: string, label: string): Promise<string> {
    return sign(secret, `derive.${label}`)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
    ])
}

export async function sign(secret: string, payload: string): Promise<string> {
    const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload))
    return base64url(sig)
}

export async function verify(secret: string, payload: string, signature: string): Promise<boolean> {
    try {
        return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(signature), encoder.encode(payload))
    } catch {
        return false
    }
}

/**
 * Every signed token names its purpose, and the purpose is part of what's signed, so a token minted
 * for one use (say, a public iframe grant anyone can obtain) can never be replayed as another (a session).
 */
export type TokenPurpose = 'session' | 'frame' | 'login'

/** Signs a JSON value with an expiry, producing `<payload>.<signature>`. */
export async function sealToken(secret: string, purpose: TokenPurpose, value: object, ttlSeconds: number): Promise<string> {
    const payload = base64url(encoder.encode(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + ttlSeconds })))
    return `${payload}.${await sign(secret, `${purpose}.${payload}`)}`
}

export async function openToken<T>(secret: string, purpose: TokenPurpose, token: string | undefined | null): Promise<T | null> {
    if (!token) return null
    const [payload, signature] = token.split('.')
    if (!payload || !signature || !(await verify(secret, `${purpose}.${payload}`, signature))) return null
    try {
        const value = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as T & { exp: number }
        return value.exp > Date.now() / 1000 ? value : null
    } catch {
        return null
    }
}
