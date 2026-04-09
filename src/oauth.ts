import * as jose from 'jose'

const getJwtSecret = () => new TextEncoder().encode(process.env.MCP_JWT_SECRET!)

export function getBaseUrl(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  return process.env.BASE_URL || 'http://localhost:3000'
}

export function generateRandomString(length: number = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, (b) => chars[b % chars.length]).join('')
}

export async function generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = generateRandomString(64)
  const data = new TextEncoder().encode(codeVerifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  return { codeVerifier, codeChallenge }
}

export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const data = new TextEncoder().encode(codeVerifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const computed = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  return computed === codeChallenge
}

export async function issueJwt(sfUserId: string, sfEmail: string): Promise<string> {
  const baseUrl = getBaseUrl()
  return new jose.SignJWT({ sub: sfUserId, email: sfEmail })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(baseUrl)
    .setAudience('salesforce-mcp')
    .setIssuedAt()
    .setExpirationTime('7d')
    .setJti(crypto.randomUUID())
    .sign(getJwtSecret())
}

export async function verifyJwt(token: string): Promise<{ sfUserId: string; email: string } | null> {
  try {
    const baseUrl = getBaseUrl()
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
      issuer: baseUrl,
      audience: 'salesforce-mcp',
    })
    if (typeof payload.sub === 'string') {
      return { sfUserId: payload.sub, email: (payload.email as string) || '' }
    }
    return null
  } catch {
    return null
  }
}
