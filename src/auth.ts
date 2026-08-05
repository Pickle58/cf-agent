import { verifyToken } from "@clerk/backend";
import type { AgentNameParts } from "./agent-name";

export type { AgentNameParts };
export { parseAgentName, agentInstanceName } from "./agent-name";

export type ConnectionAuthState = {
  authenticated: true;
  userId: string;
};

type ClerkEnv = {
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY?: string;
  AUTHORIZED_PARTIES?: string;
};

export function parseAuthorizedParties(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return ["http://localhost:5173"];
  }

  return raw
    .split(",")
    .map((party) => party.trim())
    .filter(Boolean);
}

/**
 * Verify a Clerk session JWT (from useAgent query `token` or Bearer header).
 * Returns the Clerk user id (`sub`) on success.
 */
export async function verifyClerkToken(
  token: string,
  env: ClerkEnv
): Promise<string> {
  if (!token.trim()) {
    throw new Error("Missing authentication token");
  }

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    throw new Error("Clerk verification keys are not configured");
  }

  const payload = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
    authorizedParties: parseAuthorizedParties(env.AUTHORIZED_PARTIES)
  });

  const userId = payload.sub;
  if (!userId || !userId.startsWith("user_")) {
    throw new Error("Invalid token subject");
  }

  return userId;
}

export async function authenticateBearerRequest(
  request: Request,
  env: ClerkEnv
): Promise<string> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new Error("Missing Bearer token");
  }

  return verifyClerkToken(header.slice("Bearer ".length), env);
}
