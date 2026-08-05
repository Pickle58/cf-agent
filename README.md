# Cloudflare AI Chat Agent (Clerk + D1 history)

An AI chat agent on Cloudflare Workers using the [Agents SDK](https://developers.cloudflare.com/agents/), Workers AI, Clerk auth, and D1 for durable per-user conversation archives. It can also read live pages with [Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/).

## Architecture

- **Clerk** — sign-in/sign-up; session JWTs authorize WebSocket agent connections and `/api/*`
- **`AIChatAgent`** — live chat, streaming, and reconnect recovery via Durable Object SQLite
- **Instance name** — `{clerkUserId}:{conversationId}` so users cannot open each other’s agents by guessing a UUID
- **D1 (`CHAT_HISTORY`)** — durable/queryable archive of completed conversation turns, scoped by `user_id`
- **Browser Run (`BROWSER`)** — `createQuickActionTools` exposes stateless page tools (markdown, extract, links)
- **MCP servers** — connect remote tool servers from the UI (name + HTTPS URL); tools are passed into Workers AI

## Quick start

```bash
pnpm install
clerk auth login          # once, if needed
clerk link --app <id>     # if not already linked
clerk env pull            # writes VITE_CLERK_PUBLISHABLE_KEY (+ secret) to .env.local
# Copy Worker secrets into .dev.vars (see .dev.vars.example)
pnpm db:migrate:local
pnpm dev
```

> **Cloudflare authentication is required to run locally.** Workers AI and Browser Run are configured with `"remote": true` and have no local simulator. Run `wrangler login` once, or set `CLOUDFLARE_API_TOKEN`.

Open [http://localhost:5173](http://localhost:5173). Sign in with Clerk, then chat. Reloading restores your active conversation for that user.

### Local secrets

| File         | Purpose                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `.env.local` | Vite client: `VITE_CLERK_PUBLISHABLE_KEY` (from `clerk env pull`)          |
| `.dev.vars`  | Worker: `CLERK_SECRET_KEY`, optional `CLERK_JWT_KEY`, `AUTHORIZED_PARTIES` |

`AUTHORIZED_PARTIES` is a comma-separated list of origins allowed in the Clerk session JWT `azp` claim (must include `http://localhost:5173` for local dev).

## Project structure

```
src/
  server.ts      # ChatAgent + /api/conversations
  auth.ts        # Clerk JWT verify (Worker)
  agent-name.ts  # Shared `{userId}:{conversationId}` helpers
  history.ts     # D1 helpers (user-scoped)
  client.tsx     # Clerk UI + chat + conversation list
  styles.css     # Tailwind styles
migrations/
  0001_chat_history.sql
  0002_user_scoped_history.sql
```

## Scripts

| Command                  | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `pnpm dev`               | Local development                             |
| `pnpm db:migrate:local`  | Apply D1 migrations to the local database     |
| `pnpm db:migrate:remote` | Apply D1 migrations to the remote database    |
| `pnpm check`             | Format check + lint + TypeScript              |
| `pnpm deploy`            | Migrate remote D1, build, and deploy          |
| `pnpm types`             | Regenerate Worker types after binding changes |

## Deploy

```bash
pnpm db:migrate:remote
# Set production secrets (do not commit):
wrangler secret put CLERK_SECRET_KEY
# Optional networkless verify:
# wrangler secret put CLERK_JWT_KEY
pnpm deploy
```

Update `name` in `package.json` and `wrangler.jsonc` before deploying if you want a different `*.workers.dev` URL.

### Custom domain checklist

When you attach your own domain later:

1. Add a Custom Domain route in [`wrangler.jsonc`](wrangler.jsonc):

   ```jsonc
   "routes": [{ "pattern": "chat.example.com", "custom_domain": true }]
   ```

2. Extend `vars.AUTHORIZED_PARTIES` (and `.dev.vars` / production vars) with `https://chat.example.com`.
3. In the [Clerk Dashboard](https://dashboard.clerk.com/) for this app, add the production URL to allowed origins / redirect URLs.
4. Pull production keys when ready: `clerk env pull --instance prod`.
5. Keep MCP OAuth callbacks on the **same origin** as the app so popup return URLs stay valid.

## D1 schema

- `conversations` — one row per conversation (`id`, `user_id`, timestamps)
- `messages` — full `UIMessage` JSON payloads, keyed by message ID

After a chat turn completes, `onChatResponse` mirrors `this.messages` into D1. **Clear history** empties messages for the active conversation (row kept). **Delete** in the sidebar removes the conversation from D1 and clears the Durable Object.

## Auth model

- UI is gated with Clerk (`SignIn` when signed out).
- `useAgent` passes `getToken()` as a `token` query param ([Agents cross-domain auth](https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/)).
- `ChatAgent.onConnect` verifies the JWT and rejects connections when `sub` ≠ the instance owner.
- `/api/conversations` requires `Authorization: Bearer <session JWT>`.

## Browser Run tools

ChatAgent merges Browser Run [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) into every model turn via `createQuickActionTools({ browser: this.env.BROWSER, actions: ["markdown", "extract", "links"] })`. These are stateless one-shot page reads (`browser_markdown`, `browser_extract`, `browser_links`) and need only the `BROWSER` binding. Local `wrangler dev` uses `"browser": { "binding": "BROWSER", "remote": true }`.

Example prompts:

- `Open https://example.com and summarize the page title and main heading`
- `Extract the main article text from https://example.com`
- `List the links on https://example.com`

While tools run, the chat UI shows compact status lines (tool name + state) under assistant messages.

> **Why not `createBrowserTools`?** The durable `browser_execute` tool (full CDP, persistent sessions, screenshots) needs a Worker Loader binding, and [Dynamic Workers are Workers Paid only](https://developers.cloudflare.com/dynamic-workers/pricing/). Quick Actions keep this project deployable on the free plan. To upgrade later, add `"worker_loaders": [{ "binding": "LOADER" }]`, install `@cloudflare/codemode`, `export { CodemodeRuntime } from "agents/browser"`, and swap in `createBrowserTools({ ctx: this.ctx, browser: this.env.BROWSER, loader: this.env.LOADER })`.

## Connect an MCP server

1. Open the app and click **MCP** in the header.
2. Enter a display **name** and an **HTTPS** MCP server URL (for example `https://mcp.example.com/mcp`).
3. Click **Add**. Connection state updates live (`connecting` → `ready`, or `failed`).
4. If the server requires OAuth, a popup opens (or use **Auth** on that server row). After you authorize, the popup closes and the server should become `ready`.
5. Chat as usual — available MCP tools are included in the model turn. Use **Remove** to disconnect a server.

MCP connections persist in the agent’s Durable Object storage for that conversation ID.
