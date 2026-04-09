import { createClient } from 'redis'

let redisClient: ReturnType<typeof createClient> | null = null

async function getRedis() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.KV_REDIS_URL })
    redisClient.on('error', (err) => console.error('Redis error:', err))
    await redisClient.connect()
  }
  if (!redisClient.isOpen) {
    await redisClient.connect()
  }
  return redisClient
}

// --- Dynamic Client Registration ---

export async function storeClient(clientId: string, clientInfo: Record<string, unknown>) {
  const redis = await getRedis()
  await redis.set(`client:${clientId}`, JSON.stringify(clientInfo))
}

export async function getClient(clientId: string) {
  const redis = await getRedis()
  const data = await redis.get(`client:${clientId}`)
  return data ? JSON.parse(data) : null
}

// --- OAuth State (links MCP OAuth params to SF OAuth flow, 10 min TTL) ---

export async function storeOAuthState(key: string, state: Record<string, unknown>) {
  const redis = await getRedis()
  await redis.set(`oauth_state:${key}`, JSON.stringify(state), { EX: 600 })
}

export async function getOAuthState(key: string) {
  const redis = await getRedis()
  const data = await redis.get(`oauth_state:${key}`)
  if (!data) return null
  await redis.del(`oauth_state:${key}`)
  return JSON.parse(data)
}

// --- MCP Auth Codes (exchanged for JWT, 10 min TTL, one-time use) ---

export async function storeAuthCode(code: string, data: Record<string, unknown>) {
  const redis = await getRedis()
  await redis.set(`auth_code:${code}`, JSON.stringify(data), { EX: 600 })
}

export async function getAuthCode(code: string) {
  const redis = await getRedis()
  const data = await redis.get(`auth_code:${code}`)
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
  const redis = await getRedis()
  await redis.set(`sf_tokens:${sfUserId}`, JSON.stringify(tokens))
}

export async function getSfTokens(sfUserId: string): Promise<SfTokens | null> {
  const redis = await getRedis()
  const data = await redis.get(`sf_tokens:${sfUserId}`)
  return data ? JSON.parse(data) : null
}

export async function updateSfAccessToken(sfUserId: string, accessToken: string) {
  const tokens = await getSfTokens(sfUserId)
  if (tokens) {
    tokens.accessToken = accessToken
    const redis = await getRedis()
    await redis.set(`sf_tokens:${sfUserId}`, JSON.stringify(tokens))
  }
}
