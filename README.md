# Cloudflare AI Chat Agent (D1 history)

An AI chat agent on Cloudflare Workers using the [Agents SDK](https://developers.cloudflare.com/agents/), Workers AI, and D1 for durable conversation archives. It can also read live pages with [Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/).

## Architecture

- **`AIChatAgent`** — live chat, streaming, and reconnect recovery via Durable Object SQLite
- **D1 (`CHAT_HISTORY`)** — durable/queryable archive of completed conversation turns
- **Browser Run (`BROWSER`)** — `createQuickActionTools` exposes stateless page tools (markdown, extract, links)
- **MCP servers** — connect remote tool servers from the UI (name + HTTPS URL); tools are passed into Workers AI
- **Browser conversation ID** — an unguessable UUID in `localStorage` selects the agent instance and D1 conversation key

## Quick start

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

> **Cloudflare authentication is required to run locally.** Workers AI and Browser Run are configured with `"remote": true` and have no local simulator. Run `wrangler login` once, or set `CLOUDFLARE_API_TOKEN`.

Open [http://localhost:5173](http://localhost:5173). Send a message, reload the page — the same browser conversation ID restores history from the agent (and D1 if the DO was empty).

## Project structure

```
src/
  server.ts     # ChatAgent (Workers AI + D1 archive sync)
  history.ts    # D1 helpers (upsert / list / delete)
  client.tsx    # Chat UI (useAgent + useAgentChat)
  styles.css    # Tailwind styles
migrations/
  0001_chat_history.sql
```

## Scripts

| Command                  | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `pnpm dev`               | Local development                                  |
| `pnpm db:migrate:local`  | Apply D1 migrations to the local database          |
| `pnpm db:migrate:remote` | Apply D1 migrations to the remote database         |
| `pnpm check`             | Format check + lint + TypeScript                   |
| `pnpm deploy`            | Build and deploy (`vite build && wrangler deploy`) |
| `pnpm types`             | Regenerate Worker types after binding changes      |

## Deploy

```bash
pnpm db:migrate:remote
pnpm deploy
```

Update `name` in `package.json` and `wrangler.jsonc` before deploying if you want a different `*.workers.dev` URL.

## D1 schema

- `conversations` — one row per agent/browser conversation ID
- `messages` — full `UIMessage` JSON payloads, keyed by message ID

After a chat turn completes, `onChatResponse` mirrors `this.messages` into D1. **Clear history** calls `clearConversation()`, which wipes both Durable Object SQLite and the D1 archive for that conversation (MCP connections are kept).

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
