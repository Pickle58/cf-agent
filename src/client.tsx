import "./styles.css";
import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import { ClerkProvider, Show, SignIn, UserButton, useAuth } from "@clerk/react";
import { useAgent } from "agents/react";
import type { MCPServersState } from "agents";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { agentInstanceName } from "./agent-name";
import type { AddServerResult, ChatAgent } from "./server";

type ConversationSummary = {
  id: string;
  user_id: string;
  created_at: number;
  updated_at: number;
};

const READABLE_KEY = "cf-agent-readable-markdown";
const streamdownPlugins = { code };

function activeConversationKey(userId: string): string {
  return `cf-agent-active-conversation:${userId}`;
}

function readReadablePreference(): boolean {
  const stored = localStorage.getItem(READABLE_KEY);
  if (stored === null) {
    return true;
  }
  return stored === "true";
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function toolCallStatuses(
  message: UIMessage
): Array<{ key: string; name: string; state: string }> {
  const statuses: Array<{ key: string; name: string; state: string }> = [];

  for (const part of message.parts) {
    if (!isToolUIPart(part)) {
      continue;
    }

    statuses.push({
      key: part.toolCallId,
      name: getToolName(part),
      state: part.state
    });
  }

  return statuses;
}

function toolStateLabel(state: string): string {
  switch (state) {
    case "input-streaming":
      return "preparing";
    case "input-available":
      return "running";
    case "output-available":
      return "done";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
    case "approval-requested":
      return "awaiting approval";
    case "approval-responded":
      return "approved";
    default:
      return state;
  }
}

function openOAuthPopup(authUrl: string) {
  window.open(authUrl, "mcp-oauth", "width=600,height=800,popup=yes");
}

function stateBadgeClass(state: string): string {
  switch (state) {
    case "ready":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200";
    case "authenticating":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
  }
}

function formatConversationLabel(conversation: ConversationSummary): string {
  const date = new Date(conversation.updated_at);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function apiFetch<T>(
  path: string,
  getToken: () => Promise<string | null>,
  init?: RequestInit
): Promise<T> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not signed in");
  }

  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "content-type": "application/json"
    }
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function McpModal({
  open,
  onClose,
  servers,
  toolCount,
  onAdd,
  onRemove,
  adding,
  error
}: {
  open: boolean;
  onClose: () => void;
  servers: MCPServersState["servers"];
  toolCount: number;
  onAdd: (name: string, url: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  adding: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const serverEntries = Object.entries(servers);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl || adding) {
      return;
    }

    await onAdd(trimmedName, trimmedUrl);
    setName("");
    setUrl("");
  }

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      onClose={onClose}
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">MCP Servers</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Connect a remote server by name and HTTPS URL.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-sm dark:border-zinc-700"
          >
            Close
          </button>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-2"
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Server name"
            aria-label="MCP server name"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://mcp.example.com/mcp"
              aria-label="MCP server URL"
              className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="submit"
              disabled={adding || !name.trim() || !url.trim()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
        </form>

        {error ? (
          <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        ) : null}

        {serverEntries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-3 text-xs text-zinc-500 dark:border-zinc-700">
            No MCP servers connected yet.
          </p>
        ) : (
          <ul className="max-h-60 space-y-2 overflow-y-auto">
            {serverEntries.map(([id, server]) => (
              <li
                key={id}
                className="flex items-start justify-between gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {server.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${stateBadgeClass(server.state)}`}
                    >
                      {server.state}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-500">
                    {server.server_url}
                  </p>
                  {server.state === "failed" && server.error ? (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-300">
                      {server.error}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {server.state === "authenticating" && server.auth_url ? (
                    <button
                      type="button"
                      onClick={() => openOAuthPopup(server.auth_url as string)}
                      className="rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-medium text-white"
                    >
                      Auth
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void onRemove(id)}
                    aria-label={`Remove ${server.name}`}
                    className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs dark:border-zinc-700"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {toolCount > 0 ? (
          <p className="border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-700">
            {toolCount} tool{toolCount === 1 ? "" : "s"} available from MCP
            servers
          </p>
        ) : null}
      </div>
    </dialog>
  );
}

function ChatSession({
  userId,
  conversationId,
  onMessagesChanged
}: {
  userId: string;
  conversationId: string;
  onMessagesChanged?: () => void;
}) {
  const { getToken } = useAuth();
  const [draft, setDraft] = useState("");
  const [clearing, setClearing] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [addingMcp, setAddingMcp] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [readable, setReadable] = useState(readReadablePreference);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    servers: {},
    tools: [],
    prompts: [],
    resources: []
  });

  function toggleReadable() {
    setReadable((current) => {
      const next = !current;
      localStorage.setItem(READABLE_KEY, String(next));
      return next;
    });
  }

  const agentName = useMemo(
    () => agentInstanceName(userId, conversationId),
    [userId, conversationId]
  );

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: agentName,
    query: async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("Missing Clerk session token");
      }
      return { token };
    },
    queryDeps: [userId, conversationId],
    cacheTtl: 60_000,
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, [])
  });

  const { messages, sendMessage, status, stop, error, isStreaming } =
    useAgentChat({
      agent
    });

  useEffect(() => {
    onMessagesChanged?.();
  }, [messages.length, onMessagesChanged]);

  const busy = status === "submitted" || status === "streaming" || isStreaming;
  const readyCount = Object.values(mcpState.servers).filter(
    (server) => server.state === "ready"
  ).length;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) {
      return;
    }

    setDraft("");
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text }]
    });
  }

  async function handleClear() {
    if (clearing) {
      return;
    }

    setClearing(true);
    try {
      await agent.stub.clearConversation();
    } finally {
      setClearing(false);
    }
  }

  async function handleAddServer(name: string, url: string) {
    setAddingMcp(true);
    setMcpError(null);
    try {
      const result = (await agent.stub.addServer(name, url)) as AddServerResult;
      if (result.state === "authenticating" && result.authUrl) {
        openOAuthPopup(result.authUrl);
      }
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : "Failed to add server");
    } finally {
      setAddingMcp(false);
    }
  }

  async function handleRemoveServer(id: string) {
    setMcpError(null);
    try {
      await agent.stub.removeServer(id);
    } catch (err) {
      setMcpError(
        err instanceof Error ? err.message : "Failed to remove server"
      );
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex items-start justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold">AI Chat Agent</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Conversation{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
              {conversationId.slice(0, 8)}…
            </code>{" "}
            · history archived in D1
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleReadable}
            aria-pressed={readable}
            title={
              readable
                ? "Showing rendered markdown. Click for raw."
                : "Showing raw markdown. Click for readable."
            }
            className={`rounded-lg border px-3 py-1.5 text-sm dark:border-zinc-700 ${
              readable
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-zinc-300"
            }`}
          >
            Readable
          </button>
          <button
            type="button"
            onClick={() => setShowMcp(true)}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            MCP
            {readyCount > 0 ? (
              <span className="ml-1.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {readyCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={clearing || messages.length === 0}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
          >
            {clearing ? "Clearing…" : "Clear history"}
          </button>
          <UserButton />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
            Send a message to start chatting. Ask the agent to inspect a URL, or
            use <strong>MCP</strong> to connect tool servers.
          </p>
        ) : (
          messages.map((message, index) => {
            const text = messageText(message);
            const isUser = message.role === "user";
            const tools = isUser ? [] : toolCallStatuses(message);
            const renderMarkdown = readable && !isUser;
            const isLastAssistant =
              !isUser &&
              index === messages.length - 1 &&
              message.role === "assistant";
            return (
              <article
                key={message.id}
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  renderMarkdown ? "" : "whitespace-pre-wrap"
                } ${
                  isUser
                    ? "ml-auto bg-blue-600 text-white"
                    : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                }`}
              >
                <div className="mb-1 text-[11px] font-medium uppercase opacity-70">
                  {message.role}
                </div>
                {tools.length > 0 ? (
                  <ul className="mb-2 space-y-1 font-mono text-[11px] opacity-80">
                    {tools.map((tool) => (
                      <li key={tool.key}>
                        {tool.name} · {toolStateLabel(tool.state)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {text ? (
                  renderMarkdown ? (
                    <div className="assistant-markdown [&_*]:max-w-full">
                      <Streamdown
                        plugins={streamdownPlugins}
                        isAnimating={busy && isLastAssistant}
                      >
                        {text}
                      </Streamdown>
                    </div>
                  ) : (
                    text
                  )
                ) : busy && !isUser && tools.length === 0 ? (
                  "…"
                ) : null}
              </article>
            );
          })
        )}
      </main>

      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error.message || "Something went wrong."}
        </p>
      ) : null}

      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="flex gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask anything…"
          disabled={busy}
          className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => stop()}
            className="rounded-xl bg-zinc-800 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-200 dark:text-zinc-900"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>

      <McpModal
        open={showMcp}
        onClose={() => {
          setShowMcp(false);
          setMcpError(null);
        }}
        servers={mcpState.servers}
        toolCount={mcpState.tools.length}
        onAdd={handleAddServer}
        onRemove={handleRemoveServer}
        adding={addingMcp}
        error={mcpError}
      />
    </div>
  );
}

function AuthenticatedApp({ userId }: { userId: string }) {
  const { getToken } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refreshConversations = useCallback(async () => {
    const data = await apiFetch<{ conversations: ConversationSummary[] }>(
      "/api/conversations",
      getToken
    );
    setConversations(data.conversations);
    return data.conversations;
  }, [getToken]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      setListError(null);
      try {
        const list = await refreshConversations();
        if (cancelled) {
          return;
        }

        const stored = localStorage.getItem(activeConversationKey(userId));
        const storedExists = stored
          ? list.some((conversation) => conversation.id === stored)
          : false;

        if (stored && storedExists) {
          setActiveId(stored);
          return;
        }

        if (list.length > 0) {
          setActiveId(list[0].id);
          localStorage.setItem(activeConversationKey(userId), list[0].id);
          return;
        }

        const created = await apiFetch<{ conversation: ConversationSummary }>(
          "/api/conversations",
          getToken,
          { method: "POST" }
        );
        if (cancelled) {
          return;
        }
        setConversations([created.conversation]);
        setActiveId(created.conversation.id);
        localStorage.setItem(
          activeConversationKey(userId),
          created.conversation.id
        );
      } catch (err) {
        if (!cancelled) {
          setListError(
            err instanceof Error ? err.message : "Failed to load conversations"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [userId, getToken, refreshConversations]);

  async function handleNewChat() {
    if (creating) {
      return;
    }
    setCreating(true);
    setListError(null);
    try {
      const created = await apiFetch<{ conversation: ConversationSummary }>(
        "/api/conversations",
        getToken,
        { method: "POST" }
      );
      setConversations((current) => [created.conversation, ...current]);
      setActiveId(created.conversation.id);
      localStorage.setItem(
        activeConversationKey(userId),
        created.conversation.id
      );
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : "Failed to create conversation"
      );
    } finally {
      setCreating(false);
    }
  }

  function selectConversation(id: string) {
    setActiveId(id);
    localStorage.setItem(activeConversationKey(userId), id);
  }

  async function handleDelete(id: string) {
    if (deletingId) {
      return;
    }
    setDeletingId(id);
    setListError(null);
    try {
      await apiFetch<{ ok: true }>(
        `/api/conversations/${encodeURIComponent(id)}`,
        getToken,
        { method: "DELETE" }
      );
      const remaining = conversations.filter(
        (conversation) => conversation.id !== id
      );
      setConversations(remaining);

      if (activeId === id) {
        if (remaining.length > 0) {
          setActiveId(remaining[0].id);
          localStorage.setItem(activeConversationKey(userId), remaining[0].id);
        } else {
          const created = await apiFetch<{ conversation: ConversationSummary }>(
            "/api/conversations",
            getToken,
            { method: "POST" }
          );
          setConversations([created.conversation]);
          setActiveId(created.conversation.id);
          localStorage.setItem(
            activeConversationKey(userId),
            created.conversation.id
          );
        }
      }
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : "Failed to delete conversation"
      );
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Loading conversations…
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl gap-4 p-4 font-sans text-zinc-900 dark:text-zinc-100">
      <aside className="flex w-56 shrink-0 flex-col gap-3 border-r border-zinc-200 pr-4 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Chats</h2>
          <button
            type="button"
            onClick={() => void handleNewChat()}
            disabled={creating}
            className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {creating ? "…" : "New"}
          </button>
        </div>

        {listError ? (
          <p className="rounded-lg border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {listError}
          </p>
        ) : null}

        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {conversations.map((conversation) => {
            const selected = conversation.id === activeId;
            return (
              <li key={conversation.id}>
                <div
                  className={`flex items-center gap-1 rounded-lg ${
                    selected
                      ? "bg-blue-50 dark:bg-blue-950/40"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectConversation(conversation.id)}
                    className="min-w-0 flex-1 px-2 py-2 text-left"
                  >
                    <div className="truncate font-mono text-xs">
                      {conversation.id.slice(0, 8)}…
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {formatConversationLabel(conversation)}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete conversation ${conversation.id.slice(0, 8)}`}
                    disabled={deletingId === conversation.id}
                    onClick={() => void handleDelete(conversation.id)}
                    className="mr-1 rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      {activeId ? (
        <ChatSession
          key={activeId}
          userId={userId}
          conversationId={activeId}
          onMessagesChanged={() => {
            void refreshConversations().catch(() => {
              // list refresh is best-effort after chat activity
            });
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          Create a conversation to start chatting.
        </div>
      )}
    </div>
  );
}

function App() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  if (!isLoaded) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  return (
    <>
      <Show when="signed-out">
        <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 font-sans">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              AI Chat Agent
            </h1>
            <p className="mt-2 text-sm text-zinc-500">
              Sign in to access your conversations.
            </p>
          </div>
          <SignIn routing="hash" />
        </div>
      </Show>
      <Show when="signed-in">
        {isSignedIn && userId ? <AuthenticatedApp userId={userId} /> : null}
      </Show>
    </>
  );
}

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
    <App />
  </ClerkProvider>
);
