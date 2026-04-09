import { getSfTokens, updateSfAccessToken } from './store.js'

const SF_CLIENT_ID = () => process.env.SF_CLIENT_ID!
const SF_CLIENT_SECRET = () => process.env.SF_CLIENT_SECRET!
const SF_LOGIN_URL = () => process.env.SF_LOGIN_URL || 'https://login.salesforce.com'
const SF_API_VERSION = 'v62.0'

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const resp = await fetch(`${SF_LOGIN_URL()}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: SF_CLIENT_ID(),
      client_secret: SF_CLIENT_SECRET(),
      refresh_token: refreshToken,
    }),
  })
  if (!resp.ok) return null
  const data = await resp.json()
  return data.access_token
}

export async function sfApiRequest(
  sfUserId: string,
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<{ data: unknown; error?: string }> {
  const tokens = await getSfTokens(sfUserId)
  if (!tokens) return { data: null, error: 'No Salesforce tokens found. Please reconnect.' }

  const { accessToken, refreshToken, instanceUrl } = tokens

  let url = `${instanceUrl}/services/data/${SF_API_VERSION}${path}`
  if (params) {
    url += '?' + new URLSearchParams(params).toString()
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  }
  if (body) fetchOptions.body = JSON.stringify(body)

  let resp = await fetch(url, fetchOptions)

  // Token expired — refresh and retry
  if (resp.status === 401 && refreshToken) {
    const newToken = await refreshAccessToken(refreshToken)
    if (newToken) {
      await updateSfAccessToken(sfUserId, newToken)
      fetchOptions.headers = {
        Authorization: `Bearer ${newToken}`,
        'Content-Type': 'application/json',
      }
      resp = await fetch(url, fetchOptions)
    }
  }

  if (!resp.ok) {
    const errBody = await resp.text()
    return { data: null, error: `Salesforce API error (${resp.status}): ${errBody}` }
  }

  // PATCH/DELETE returns 204 with no body
  if (resp.status === 204) return { data: { success: true } }

  return { data: await resp.json() }
}

export async function exchangeSfAuthCode(
  code: string,
  redirectUri: string,
): Promise<{
  access_token: string
  refresh_token: string
  instance_url: string
  id: string
} | null> {
  const resp = await fetch(`${SF_LOGIN_URL()}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: SF_CLIENT_ID(),
      client_secret: SF_CLIENT_SECRET(),
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!resp.ok) return null
  return resp.json()
}

export async function getSfUserInfo(
  instanceUrl: string,
  accessToken: string,
): Promise<{ user_id: string; email: string; display_name: string } | null> {
  const resp = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) return null
  const data = await resp.json()
  return {
    user_id: data.user_id,
    email: data.email,
    display_name: data.name,
  }
}
