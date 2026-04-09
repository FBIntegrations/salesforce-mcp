import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
})

// --- Dynamic Client Registration ---

export async function storeClient(clientId: string, clientInfo: Record<string, unknown>) {
  await redis.set(`client:${clientId}`, JSON.stringify(clientInfo))
}

export async function getClient(clientId: string) {
  const data = await redis.get<string>(`client:${clientId}`)
  return data ? JSON.parse(data) : null
}

// --- OAuth State (links MCP OAuth params to SF OAuth flow, 10 min TTL) ---

export async function storeOAuthState(key: string, state: Record<string, unknown>) {
  await redis.set(`oauth_state:${key}`, JSON.stringify(state), { ex: 600 })
}

export async function getOAuthState(key: string) {
  const data = await redis.get<string>(`oauth_state:${key}`)
  if (!data) return null
  await redis.del(`oauth_state:${key}`)
  return JSON.parse(data)
}

// --- MCP Auth Codes (exchanged for JWT, 10 min TTL, one-time use) ---

export async function storeAuthCode(code: string, data: Record<string, unknown>) {
  await redis.set(`auth_code:${code}`, JSON.stringify(data), { ex: 600 })
}

export async function getAuthCode(code: string) {
  const data = await redis.get<string>(`auth_code:${code}`)
  if (!data) return null
  await redis.del(`auth_code:${code}`)
  return JSON.parse(data)
}

// --- SF Tokens (persistent, keyed by SF user ID) ---

export interface SfTokens {
  accessToken: string
  refreshToken: string
  instanceUrl: string
}

export async function storeSfTokens(sfUserId: string, tokens: SfTokens) {
  await redis.set(`sf_tokens:${sfUserId}`, JSON.stringify(tokens))
}

export async function getSfTokens(sfUserId: string): Promise<SfTokens | null> {
  const data = await redis.get<string>(`sf_tokens:${sfUserId}`)
  return data ? JSON.parse(data) : null
}

export async function updateSfAccessToken(sfUserId: string, accessToken: string) {
  const tokens = await getSfTokens(sfUserId)
  if (tokens) {
    tokens.accessToken = accessToken
    await redis.set(`sf_tokens:${sfUserId}`, JSON.stringify(tokens))
  }
}
