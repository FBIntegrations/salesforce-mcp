import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { getBaseUrl, generateRandomString, generatePkce, verifyPkce, issueJwt, verifyJwt } from './oauth.js'
import {
  storeClient,
  storeOAuthState,
  getOAuthState,
  storeAuthCode,
  getAuthCode,
  storeSfTokens,
  getSfTokens,
} from './store.js'
import { exchangeSfAuthCode, getSfUserInfo } from './salesforce.js'
import { registerTools } from './tools.js'

const app = new Hono().basePath('/api')

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

// CORS preflight
app.options('*', () => new Response(null, { status: 204, headers: corsHeaders }))

// ──────────────────────────────────────
// Health check
// ──────────────────────────────────────

app.get('/', (c) => c.json({ status: 'ok', service: 'salesforce-mcp' }))

// ──────────────────────────────────────
// OAuth Discovery
// ──────────────────────────────────────

app.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = getBaseUrl()
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['openid'],
    bearer_methods_supported: ['header'],
  })
})

app.get('/.well-known/oauth-authorization-server', (c) => {
  const baseUrl = getBaseUrl()
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    scopes_supported: ['openid'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  })
})

app.get('/.well-known/openid-configuration', (c) => {
  const baseUrl = getBaseUrl()
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    scopes_supported: ['openid'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  })
})

// ──────────────────────────────────────
// Dynamic Client Registration
// ──────────────────────────────────────

app.post('/register', async (c) => {
  const body = await c.req.json()
  const clientId = crypto.randomUUID()
  const clientInfo = {
    client_id: clientId,
    client_name: body.client_name || 'MCP Client',
    redirect_uris: body.redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
  await storeClient(clientId, clientInfo)
  return c.json(clientInfo, 201)
})

// ──────────────────────────────────────
// OAuth Authorization → Salesforce Login
// ──────────────────────────────────────

app.get('/authorize', async (c) => {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state } = c.req.query()

  // Generate PKCE for SF-side OAuth (separate from MCP-side PKCE)
  const sfPkce = await generatePkce()

  // Store MCP OAuth params + SF PKCE verifier with a temp key
  const tempKey = generateRandomString(32)
  await storeOAuthState(tempKey, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    sfCodeVerifier: sfPkce.codeVerifier,
  })

  const baseUrl = getBaseUrl()
  const sfLoginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com'

  // Redirect to Salesforce login with PKCE
  const sfAuthUrl = new URL(`${sfLoginUrl}/services/oauth2/authorize`)
  sfAuthUrl.searchParams.set('response_type', 'code')
  sfAuthUrl.searchParams.set('client_id', process.env.SF_CLIENT_ID!)
  sfAuthUrl.searchParams.set('redirect_uri', `${baseUrl}/callback`)
  sfAuthUrl.searchParams.set('state', tempKey)
  sfAuthUrl.searchParams.set('scope', 'full refresh_token')
  sfAuthUrl.searchParams.set('code_challenge', sfPkce.codeChallenge)
  sfAuthUrl.searchParams.set('code_challenge_method', 'S256')

  return c.redirect(sfAuthUrl.toString())
})

// ──────────────────────────────────────
// OAuth Callback ← Salesforce
// ──────────────────────────────────────

app.get('/callback', async (c) => {
  const sfCode = c.req.query('code')
  const tempKey = c.req.query('state')
  const sfError = c.req.query('error')

  if (sfError) {
    return c.text(`Salesforce login failed: ${sfError} - ${c.req.query('error_description') || ''}`, 400)
  }

  if (!sfCode || !tempKey) {
    return c.text('Missing authorization code or state parameter', 400)
  }

  // Retrieve stored MCP OAuth params
  const oauthState = await getOAuthState(tempKey)
  if (!oauthState) {
    return c.text('Invalid or expired authorization state. Please try connecting again.', 400)
  }

  const baseUrl = getBaseUrl()

  // Exchange SF auth code for SF tokens (with PKCE verifier)
  const sfTokens = await exchangeSfAuthCode(sfCode, `${baseUrl}/callback`, oauthState.sfCodeVerifier)
  if (!sfTokens) {
    return c.text('Failed to exchange Salesforce authorization code. Please try again.', 500)
  }

  // Get SF user info
  const userInfo = await getSfUserInfo(sfTokens.instance_url, sfTokens.access_token)
  if (!userInfo) {
    return c.text('Failed to retrieve Salesforce user info.', 500)
  }

  // Store SF tokens in Redis keyed by SF user ID
  await storeSfTokens(userInfo.user_id, {
    accessToken: sfTokens.access_token,
    refreshToken: sfTokens.refresh_token,
    instanceUrl: sfTokens.instance_url,
  })

  // Generate MCP auth code (to exchange for our JWT)
  const mcpCode = generateRandomString(64)
  await storeAuthCode(mcpCode, {
    sfUserId: userInfo.user_id,
    sfEmail: userInfo.email,
    clientId: oauthState.client_id,
    redirectUri: oauthState.redirect_uri,
    codeChallenge: oauthState.code_challenge,
    codeChallengeMethod: oauthState.code_challenge_method,
  })

  // Redirect to Claude's callback with our MCP auth code
  const redirectUrl = new URL(oauthState.redirect_uri)
  redirectUrl.searchParams.set('code', mcpCode)
  if (oauthState.state) {
    redirectUrl.searchParams.set('state', oauthState.state)
  }

  return c.redirect(redirectUrl.toString())
})

// ──────────────────────────────────────
// Token Exchange (MCP auth code → JWT)
// ──────────────────────────────────────

app.post('/token', async (c) => {
  let body: Record<string, string>
  const contentType = c.req.header('content-type') || ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    body = (await c.req.parseBody()) as Record<string, string>
  } else {
    body = await c.req.json()
  }

  const { grant_type, code, code_verifier, redirect_uri } = body

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400)
  }

  // Look up auth code (one-time use)
  const codeData = await getAuthCode(code)
  if (!codeData) {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400)
  }

  // Verify redirect_uri matches
  if (redirect_uri && redirect_uri !== codeData.redirectUri) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
  }

  // Verify PKCE
  if (codeData.codeChallenge) {
    if (!code_verifier) {
      return c.json({ error: 'invalid_grant', error_description: 'code_verifier required' }, 400)
    }
    const valid = await verifyPkce(code_verifier, codeData.codeChallenge)
    if (!valid) {
      return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
    }
  }

  // Issue JWT
  const accessToken = await issueJwt(codeData.sfUserId, codeData.sfEmail)

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 604800, // 7 days
  })
})

// ──────────────────────────────────────
// MCP Endpoint (Bearer token required)
// ──────────────────────────────────────

app.all('/mcp', async (c) => {
  const baseUrl = getBaseUrl()

  // Verify Bearer token
  const authHeader = c.req.header('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      },
    })
  }

  const token = authHeader.slice(7)
  const user = await verifyJwt(token)
  if (!user) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      },
    })
  }

  // Verify SF tokens exist
  const sfTokens = await getSfTokens(user.sfUserId)
  if (!sfTokens) {
    return new Response(
      JSON.stringify({ error: 'Salesforce session not found. Please reconnect.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Create MCP server with tools for this user
  const server = new McpServer(
    { name: 'salesforce-mcp', version: '1.0.0' },
    {
      instructions:
        'Salesforce MCP server for Furniture Bank. Use sf_describe_object before writing SOQL queries to verify field names. Use sf_search_reports to find report IDs before running them.',
    },
  )

  registerTools(server, user.sfUserId)

  // Stateless transport with JSON responses (no SSE needed for serverless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await server.connect(transport)

  const response = await transport.handleRequest(c.req.raw)

  // Add CORS headers
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value)
  }

  return response
})

export default app
