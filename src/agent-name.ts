export type AgentNameParts = {
  userId: string;
  conversationId: string;
};

/**
 * Parse Durable Object instance names of the form `{clerkUserId}:{conversationId}`.
 * Clerk user ids are `user_…` and never contain `:`.
 */
export function parseAgentName(name: string): AgentNameParts {
  const separator = name.indexOf(":");
  if (separator <= 0 || separator === name.length - 1) {
    throw new Error("Invalid agent instance name");
  }

  const userId = name.slice(0, separator);
  const conversationId = name.slice(separator + 1);

  if (!userId.startsWith("user_") || !conversationId) {
    throw new Error("Invalid agent instance name");
  }

  return { userId, conversationId };
}

export function agentInstanceName(
  userId: string,
  conversationId: string
): string {
  return `${userId}:${conversationId}`;
}
