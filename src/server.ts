import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import {
  callable,
  getAgentByName,
  getCurrentAgent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext
} from "agents";
import { createQuickActionTools } from "agents/browser/ai";
import {
  convertToModelMessages,
  type StreamTextOnFinishCallback,
  stepCountIs,
  streamText,
  type ToolSet
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  agentInstanceName,
  authenticateBearerRequest,
  parseAgentName,
  verifyClerkToken,
  type ConnectionAuthState
} from "./auth";
import {
  conversationOwnedByUser,
  createConversation,
  deleteConversation,
  listConversationMessages,
  listConversationsForUser,
  syncConversationMessages
} from "./history";

export type AddServerResult =
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string };

/**
 * Streaming chat agent. Durable Object SQLite holds the live transcript and
 * stream buffers; completed turns are mirrored into D1 for durable queries.
 * Instance name is `{clerkUserId}:{conversationId}`; WebSocket clients must
 * present a Clerk session JWT that matches the owner.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;
  waitForMcpConnections = true;

  private ownerUserId(): string {
    return parseAgentName(this.name).userId;
  }

  private conversationId(): string {
    return parseAgentName(this.name).conversationId;
  }

  /**
   * When a WebSocket caller is present, require connection auth state to match
   * the Durable Object owner. Worker-side stub calls (no connection) are used
   * only after the fetch handler has already authorized the user.
   */
  private requireCallerOwnsAgent(): string {
    const ownerUserId = this.ownerUserId();
    const { connection } = getCurrentAgent();
    if (!connection) {
      return ownerUserId;
    }

    const state = connection.state as ConnectionAuthState | undefined;
    if (!state?.authenticated || state.userId !== ownerUserId) {
      throw new Error("Unauthorized");
    }

    return ownerUserId;
  }

  override async onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    try {
      const url = new URL(ctx.request.url);
      const token = url.searchParams.get("token");
      if (!token) {
        connection.close(4001, "Unauthorized");
        return;
      }

      const userId = await verifyClerkToken(token, this.env);
      const ownerUserId = this.ownerUserId();
      if (userId !== ownerUserId) {
        connection.close(4001, "Unauthorized");
        return;
      }

      connection.setState({
        authenticated: true,
        userId
      } satisfies ConnectionAuthState);
    } catch {
      connection.close(4001, "Unauthorized");
      return;
    }

    await super.onConnect(connection, ctx);
  }

  override async onStart(): Promise<void> {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }

        const message = result.authError || "Unknown error";
        return new Response(`Authentication Failed: ${message}`, {
          headers: { "content-type": "text/plain" },
          status: 400
        });
      }
    });

    if (this.messages.length > 0) {
      return;
    }

    const archived = await listConversationMessages(
      this.env.CHAT_HISTORY,
      this.ownerUserId(),
      this.conversationId()
    );
    if (archived.length > 0) {
      await this.persistMessages(archived);
    }
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: OnChatMessageOptions
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const browserTools = createQuickActionTools({
      browser: this.env.BROWSER,
      actions: ["markdown", "extract", "links"]
    });
    const mcpTools = this.mcp.getAITools();
    const tools = {
      ...browserTools,
      ...mcpTools
    };

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant running on Cloudflare Workers AI. Be concise and clear. You can read live web pages with the browser tools (markdown, extract, links). When MCP tools are available, use them when they help answer the user.",
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(10),
      // AIChatAgent types onFinish against ToolSet; merged tools are a concrete ToolSet subtype.
      onFinish: onFinish as unknown as StreamTextOnFinishCallback<typeof tools>
    });

    return result.toUIMessageStreamResponse();
  }

  protected override async onChatResponse(
    result: ChatResponseResult
  ): Promise<void> {
    if (result.status !== "completed" && result.status !== "aborted") {
      return;
    }

    try {
      await syncConversationMessages(
        this.env.CHAT_HISTORY,
        this.ownerUserId(),
        this.conversationId(),
        this.messages
      );
    } catch (error) {
      console.error("Failed to archive conversation to D1", {
        conversationId: this.conversationId(),
        userId: this.ownerUserId(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Connect a remote MCP server (HTTPS only). May return an OAuth authUrl.
   */
  @callable()
  async addServer(name: string, url: string): Promise<AddServerResult> {
    this.requireCallerOwnsAgent();

    const trimmedName = name.trim();
    const trimmedUrl = url.trim();

    if (!trimmedName) {
      throw new Error("Server name is required");
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      throw new Error("Server URL must be a valid absolute URL");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("Server URL must use https:");
    }

    const result = await this.addMcpServer(trimmedName, trimmedUrl);

    if (result.state === "authenticating") {
      return {
        id: result.id,
        state: "authenticating",
        authUrl: result.authUrl
      };
    }

    return { id: result.id, state: "ready" };
  }

  /**
   * Disconnect an MCP server and remove it from agent storage.
   */
  @callable()
  async removeServer(serverId: string): Promise<{ ok: true }> {
    this.requireCallerOwnsAgent();

    const id = serverId.trim();
    if (!id) {
      throw new Error("Server id is required");
    }
    await this.removeMcpServer(id);
    return { ok: true };
  }

  /**
   * Clear the live Durable Object transcript and D1 messages for this
   * conversation. The conversation row is kept so it remains in the user's
   * list. MCP server connections are left intact.
   */
  @callable()
  async clearConversation(): Promise<{ ok: true }> {
    const userId = this.requireCallerOwnsAgent();
    this.resetTurnState();
    await this.persistMessages([]);
    await syncConversationMessages(
      this.env.CHAT_HISTORY,
      userId,
      this.conversationId(),
      []
    );
    return { ok: true };
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorJson(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function handleConversationsApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/conversations")) {
    return null;
  }

  let userId: string;
  try {
    userId = await authenticateBearerRequest(request, env);
  } catch {
    return errorJson("Unauthorized", 401);
  }

  if (url.pathname === "/api/conversations") {
    if (request.method === "GET") {
      const conversations = await listConversationsForUser(
        env.CHAT_HISTORY,
        userId
      );
      return json({ conversations });
    }

    if (request.method === "POST") {
      const conversationId = crypto.randomUUID();
      const conversation = await createConversation(
        env.CHAT_HISTORY,
        userId,
        conversationId
      );
      return json({ conversation }, 201);
    }

    return errorJson("Method not allowed", 405);
  }

  const match = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (!match) {
    return errorJson("Not found", 404);
  }

  const conversationId = decodeURIComponent(match[1]);

  if (request.method === "DELETE") {
    const owned = await conversationOwnedByUser(
      env.CHAT_HISTORY,
      userId,
      conversationId
    );
    if (!owned) {
      return errorJson("Not found", 404);
    }

    try {
      const agent = await getAgentByName(
        env.ChatAgent,
        agentInstanceName(userId, conversationId)
      );
      await agent.clearConversation();
    } catch (error) {
      console.error("Best-effort DO clear failed", {
        conversationId,
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    await deleteConversation(env.CHAT_HISTORY, userId, conversationId);
    return json({ ok: true });
  }

  return errorJson("Method not allowed", 405);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const apiResponse = await handleConversationsApi(request, env);
    if (apiResponse) {
      return apiResponse;
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
