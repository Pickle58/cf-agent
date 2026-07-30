import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import {
  convertToModelMessages,
  type StreamTextOnFinishCallback,
  stepCountIs,
  streamText,
  type ToolSet
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  deleteConversation,
  listConversationMessages,
  syncConversationMessages
} from "./history";

export type AddServerResult =
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string };

/**
 * Streaming chat agent. Durable Object SQLite holds the live transcript and
 * stream buffers; completed turns are mirrored into D1 for durable queries.
 * MCP servers are managed per conversation instance via addServer/removeServer.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;
  waitForMcpConnections = true;

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
      this.name
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
    const mcpTools = this.mcp.getAITools();

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant running on Cloudflare Workers AI. Be concise and clear. When MCP tools are available, use them when they help answer the user.",
      messages: await convertToModelMessages(this.messages),
      tools: mcpTools,
      stopWhen: stepCountIs(5),
      // AIChatAgent types onFinish against ToolSet; MCP tools are a concrete ToolSet subtype.
      onFinish: onFinish as unknown as StreamTextOnFinishCallback<
        typeof mcpTools
      >
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
        this.name,
        this.messages
      );
    } catch (error) {
      console.error("Failed to archive conversation to D1", {
        conversationId: this.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Connect a remote MCP server (HTTPS only). May return an OAuth authUrl.
   */
  @callable()
  async addServer(name: string, url: string): Promise<AddServerResult> {
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
    const id = serverId.trim();
    if (!id) {
      throw new Error("Server id is required");
    }
    await this.removeMcpServer(id);
    return { ok: true };
  }

  /**
   * Clear both the live Durable Object transcript and the D1 archive.
   * MCP server connections are left intact.
   */
  @callable()
  async clearConversation(): Promise<{ ok: true }> {
    this.resetTurnState();
    await this.persistMessages([]);
    await deleteConversation(this.env.CHAT_HISTORY, this.name);
    return { ok: true };
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
