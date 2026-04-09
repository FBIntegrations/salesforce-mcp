# Salesforce MCP Server

A remote MCP (Model Context Protocol) server that lets Claude Desktop users query and modify Salesforce data using their own Salesforce credentials. Each user authenticates independently — their Salesforce profile and permissions control what they can access.

**Deployed at:** `https://salesforce-mcp-sigma.vercel.app`
**Repo:** `github.com/FBIntegrations/salesforce-mcp`

---

## For Users (Non-Technical)

### What This Does

This server connects Claude (the AI assistant) to your Salesforce org. Once connected, you can ask Claude things like:

- "Show me all Opportunities closing this month"
- "Look up the contact record for Jane Smith"
- "Create a new Task on this Account"
- "Run the Monthly Donations report"

Claude uses your own Salesforce login, so you only see data you're allowed to see.

### How to Connect

1. Open **Claude Desktop** (or claude.ai)
2. Go to **Settings → Connectors** (or MCP Servers)
3. Add a new remote server with URL: `https://salesforce-mcp-sigma.vercel.app/mcp`
4. Claude will open a Salesforce login page in your browser
5. Log in with your Salesforce credentials and click **Allow**
6. You're connected — you should see 9 Salesforce tools available

### What You Can Do

| Action | Example Prompt |
|--------|---------------|
| Query data | "Show me the 10 most recent Donations" |
| Look up a record | "Get the Account record for Furniture Bank" |
| Explore objects | "What fields does the Opportunity object have?" |
| Find reports | "Search for reports about revenue" |
| Run a report | "Run the Monthly Donations report" |
| View a dashboard | "Show me the Fundraising dashboard" |
| Create a record | "Create a new Task assigned to me on this Account" |
| Update a record | "Change the Opportunity stage to Closed Won" |

### Troubleshooting

- **"Could not connect"** — Try disconnecting and reconnecting. The server may have restarted.
- **"Salesforce session not found"** — Your token expired. Disconnect and reconnect to re-authenticate.
- **You can't see certain data** — Claude uses your Salesforce profile permissions. If you can't see it in Salesforce, Claude can't see it either.

---

## For Developers

### Architecture

```
Claude Desktop                    Vercel (Hono)                    Salesforce
     │                                │                                │
     │── POST /register ──────────────│                                │
     │── GET /authorize ──────────────│── redirect to SF login ───────→│
     │                                │←─ callback with SF auth code ──│
     │                                │── exchange code for SF tokens ─→│
     │                                │── store tokens in Redis         │
     │←─ redirect with MCP auth code ─│                                │
     │── POST /token (PKCE verify) ──→│── issue JWT ──────────────────→│
     │                                │                                │
     │── POST /mcp (Bearer JWT) ─────→│── SF API call (Bearer token) ─→│
     │←─ MCP JSON-RPC response ───────│←─ SF API response ────────────│
```

**Double OAuth Dance:**
1. **MCP OAuth** (Claude ↔ this server): Claude authenticates using OAuth 2.1 with PKCE. Server issues a JWT.
2. **Salesforce OAuth** (this server ↔ Salesforce): Server authenticates with Salesforce using OAuth 2.0 with PKCE via an External Client App (ECA).

### Tech Stack

- **Runtime:** Node.js on Vercel (serverless)
- **Framework:** [Hono](https://hono.dev) — lightweight, Vercel-native
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.29+ — `McpServer` + `WebStandardStreamableHTTPServerTransport` (stateless JSON mode)
- **Token Storage:** Redis (Redis Cloud via Vercel, standard `redis` npm package over TCP)
- **JWT:** `jose` library, HS256, 7-day expiry
- **Validation:** `zod` for MCP tool input schemas

### File Structure

```
salesforce-mcp/
├── src/
│   ├── index.ts        # Hono routes: health, OAuth discovery, authorize, callback, token, /mcp
│   ├── store.ts        # Redis operations (lazy TCP connection via KV_REDIS_URL)
│   ├── oauth.ts        # PKCE generation/verification, JWT issue/verify, base URL helper
│   ├── salesforce.ts   # SF REST API client with automatic token refresh on 401
│   └── tools.ts        # 9 MCP tool registrations (7 read, 2 write)
├── package.json        # ESM module, no build script (Hono preset handles build)
├── tsconfig.json       # ESNext + NodeNext, strict mode
└── .gitignore
```

### Key Files Explained

**`src/index.ts`** — The main application. Routes:
- `GET /` — Health check with env var validation
- `GET /.well-known/*` — OAuth discovery endpoints (MCP standard)
- `POST /register` — Dynamic client registration
- `GET /authorize` — Starts OAuth: stores MCP params in Redis, generates SF-side PKCE, redirects to Salesforce login
- `GET /callback` — Handles Salesforce redirect: exchanges SF auth code for tokens, discovers user identity, stores tokens in Redis, generates MCP auth code, redirects back to Claude
- `POST /token` — Exchanges MCP auth code for JWT (with PKCE verification)
- `ALL /mcp` — The MCP endpoint: verifies JWT, retrieves SF tokens from Redis, creates a fresh McpServer per request, handles the JSON-RPC request

**`src/salesforce.ts`** — API client. The `sfApiRequest()` function:
- Retrieves the user's SF tokens from Redis
- Makes the API call with Bearer token
- If SF returns 401 (expired token), automatically refreshes via `refresh_token` grant, updates Redis, and retries
- Returns `{ data, error }` — tools check for `error` and return it as an MCP error response

**`src/store.ts`** — Redis operations with lazy connection. Key patterns:
- `sf_tokens:{sfUserId}` — Persistent, stores access token + refresh token + instance URL
- `oauth_state:{tempKey}` — 10-minute TTL, bridges the authorize→callback flow
- `auth_code:{code}` — 10-minute TTL, one-time use (deleted after retrieval)
- `client:{clientId}` — Persistent, stores dynamic client registrations

**`src/tools.ts`** — All 9 MCP tools registered via `registerTools(server, sfUserId)`. Each tool:
- Uses Zod schemas for input validation
- Calls `sfApiRequest()` with the user's ID (captured via closure)
- Returns MCP-formatted responses (`{ content: [{ type: 'text', text: ... }] }`)

### Tools Reference

| Tool | Method | SF API Endpoint | Params |
|------|--------|-----------------|--------|
| `sf_query` | GET | `/query?q={soql}` | query |
| `sf_get_record` | GET | `/sobjects/{type}/{id}` | objectType, recordId |
| `sf_describe_object` | GET | `/sobjects/{type}/describe` | objectType |
| `sf_list_objects` | GET | `/sobjects` | — |
| `sf_search_reports` | GET | `/analytics/reports?q={keyword}` | query |
| `sf_run_report` | GET | `/analytics/reports/{id}?includeDetails=true` | reportId |
| `sf_get_dashboard` | GET | `/analytics/dashboards/{id}` | dashboardId |
| `sf_create_record` | POST | `/sobjects/{type}` | objectType, fields |
| `sf_update_record` | PATCH | `/sobjects/{type}/{id}` | objectType, recordId, fields |

**Intentionally omitted:** `sf_delete_record` — too dangerous for AI use. Users should delete records manually in Salesforce.

### Environment Variables

Set these in Vercel → Project Settings → Environment Variables:

| Variable | Description | Where to Get It |
|----------|-------------|-----------------|
| `SF_CLIENT_ID` | Salesforce External Client App (ECA) client ID | SF Setup → App Manager → Your ECA |
| `SF_CLIENT_SECRET` | Salesforce ECA client secret | Same place |
| `MCP_JWT_SECRET` | Random secret for signing JWTs | Generate with `openssl rand -base64 48` |
| `KV_REDIS_URL` | Redis connection string (TCP protocol) | Vercel → Storage → your Redis instance |

Auto-set by Vercel:
- `VERCEL_PROJECT_PRODUCTION_URL` — Used to build OAuth callback URLs

### Salesforce Configuration

**External Client App (ECA):**
- Name: "n8n Connector" (shared with n8n — name cosmetic only)
- PKCE: Enabled (checked)
- Callback URLs: `https://salesforce-mcp-sigma.vercel.app/callback`
- OAuth Scopes: `full`, `refresh_token`

**Important:** Salesforce is deprecating Connected Apps in favor of External Client Apps (ECAs) as of Spring '26.

### How to Add a New Tool

1. Open `src/tools.ts`
2. Add a new `server.registerTool()` call inside `registerTools()`:

```typescript
server.registerTool('sf_my_new_tool', {
  title: 'My New Tool',
  description: 'What this tool does...',
  inputSchema: {
    param1: z.string().describe('What this param is'),
  },
  annotations: { readOnlyHint: true }, // omit for write tools
}, async ({ param1 }) => {
  const { data, error } = await sfApiRequest(sfUserId, 'GET', `/some/endpoint/${param1}`)
  if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
})
```

3. Commit, push, and Vercel auto-deploys.

### How to Deploy from Scratch

1. Clone: `git clone https://github.com/FBIntegrations/salesforce-mcp.git`
2. `npm install`
3. Import into Vercel — select **Hono** framework preset
4. Add env vars (see table above)
5. Create a Salesforce External Client App with PKCE enabled
6. Set the ECA callback URL to `https://{your-vercel-domain}/callback`
7. Deploy — hit `/` to verify health check

### Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| `/register` returns 500 | Redis not connected | Check `KV_REDIS_URL` env var is set |
| OAuth redirect fails | Callback URL mismatch | Ensure SF ECA has exact callback URL matching `VERCEL_PROJECT_PRODUCTION_URL` |
| All routes 404 | Build script conflict | Remove any `"build"` script from package.json — Hono preset handles it |
| Tools return "session not found" | SF token expired and refresh failed | User should disconnect and reconnect |
| FUNCTION_INVOCATION_TIMEOUT | api/ directory exists | Delete any `api/` directory — Hono preset doesn't use it |

---

## Redis Key Reference

All keys use the default prefix (no namespace). Shared Redis instance with basecamp-mcp (which uses `bc_` prefix).

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `client:{uuid}` | ∞ | MCP client registrations |
| `oauth_state:{random}` | 10 min | Bridges authorize → callback |
| `auth_code:{random}` | 10 min | One-time exchange for JWT |
| `sf_tokens:{sfUserId}` | ∞ | Per-user SF access + refresh tokens |
