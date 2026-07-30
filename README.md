# Cloudflare AI Chat Agent (D1 history)

An AI chat agent on Cloudflare Workers using the [Agents SDK](https://developers.cloudflare.com/agents/), Workers AI, and D1 for durable conversation archives.

## Architecture

- **`AIChatAgent`** — live chat, streaming, and reconnect recovery via Durable Object SQLite
- **D1 (`CHAT_HISTORY`)** — durable/queryable archive of completed conversation turns
- **MCP servers** — connect remote tool servers from the UI (name + HTTPS URL); tools are passed into Workers AI
- **Browser conversation ID** — an unguessable UUID in `localStorage` selects the agent instance and D1 conversation key

## Quick start

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

> **Cloudflare authentication is required to run locally.** Workers AI is configured with `"remote": true` and has no local simulator. Run `wrangler login` once, or set `CLOUDFLARE_API_TOKEN`.

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

## Connect an MCP server

1. Open the app and click **MCP** in the header.
2. Enter a display **name** and an **HTTPS** MCP server URL (for example `https://mcp.example.com/mcp`).
3. Click **Add**. Connection state updates live (`connecting` → `ready`, or `failed`).
4. If the server requires OAuth, a popup opens (or use **Auth** on that server row). After you authorize, the popup closes and the server should become `ready`.
5. Chat as usual — available MCP tools are included in the model turn. Use **Remove** to disconnect a server.

MCP connections persist in the agent’s Durable Object storage for that conversation ID.
