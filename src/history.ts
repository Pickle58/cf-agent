import type { UIMessage } from "ai";

export type ConversationSummary = {
  id: string;
  user_id: string;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  payload: string;
  created_at: number;
};

/**
 * Ensure a conversation row exists for the owning user and refresh updated_at.
 */
export async function upsertConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
  updatedAt = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversations (id, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at
       WHERE conversations.user_id = excluded.user_id`
    )
    .bind(conversationId, userId, updatedAt, updatedAt)
    .run();
}

/**
 * List conversations owned by a user, most recently updated first.
 */
export async function listConversationsForUser(
  db: D1Database,
  userId: string
): Promise<ConversationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, created_at, updated_at
       FROM conversations
       WHERE user_id = ?
       ORDER BY updated_at DESC, created_at DESC`
    )
    .bind(userId)
    .all<ConversationSummary>();

  return results ?? [];
}

/**
 * Create a new conversation id for a user (or refresh if it already exists).
 */
export async function createConversation(
  db: D1Database,
  userId: string,
  conversationId: string
): Promise<ConversationSummary> {
  const now = Date.now();
  await upsertConversation(db, userId, conversationId, now);
  return {
    id: conversationId,
    user_id: userId,
    created_at: now,
    updated_at: now
  };
}

/**
 * Return true when the conversation exists and belongs to the user.
 */
export async function conversationOwnedByUser(
  db: D1Database,
  userId: string,
  conversationId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM conversations WHERE id = ? AND user_id = ? LIMIT 1`
    )
    .bind(conversationId, userId)
    .first<{ id: string }>();

  return row !== null;
}

/**
 * Idempotently mirror the full message list for a conversation into D1.
 * Existing message IDs are upserted; rows not present in `messages` are removed
 * so clears and truncations stay consistent with the live agent transcript.
 */
export async function syncConversationMessages(
  db: D1Database,
  userId: string,
  conversationId: string,
  messages: UIMessage[]
): Promise<void> {
  const now = Date.now();
  await upsertConversation(db, userId, conversationId, now);

  const owned = await conversationOwnedByUser(db, userId, conversationId);
  if (!owned) {
    throw new Error("Conversation not found or not owned by user");
  }

  if (messages.length === 0) {
    await db
      .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
      .bind(conversationId)
      .run();
    return;
  }

  const statements: D1PreparedStatement[] = [];

  for (const [index, message] of messages.entries()) {
    // Preserve list order with stable timestamps; UIMessage has no createdAt.
    const createdAt = now + index;
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, payload, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             conversation_id = excluded.conversation_id,
             role = excluded.role,
             payload = excluded.payload`
        )
        .bind(
          message.id,
          conversationId,
          message.role,
          JSON.stringify(message),
          createdAt
        )
    );
  }

  const placeholders = messages.map(() => "?").join(", ");
  statements.push(
    db
      .prepare(
        `DELETE FROM messages
         WHERE conversation_id = ?
           AND id NOT IN (${placeholders})`
      )
      .bind(conversationId, ...messages.map((message) => message.id))
  );

  await db.batch(statements);
}

/**
 * Load archived messages for a conversation owned by the user, oldest first.
 */
export async function listConversationMessages(
  db: D1Database,
  userId: string,
  conversationId: string
): Promise<UIMessage[]> {
  const owned = await conversationOwnedByUser(db, userId, conversationId);
  if (!owned) {
    return [];
  }

  const { results } = await db
    .prepare(
      `SELECT id, conversation_id, role, payload, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .bind(conversationId)
    .all<MessageRow>();

  return (results ?? []).map((row) => JSON.parse(row.payload) as UIMessage);
}

/**
 * Delete a conversation and all of its archived messages when owned by userId.
 * Returns false when the conversation does not exist for that user.
 */
export async function deleteConversation(
  db: D1Database,
  userId: string,
  conversationId: string
): Promise<boolean> {
  const owned = await conversationOwnedByUser(db, userId, conversationId);
  if (!owned) {
    return false;
  }

  await db.batch([
    db
      .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
      .bind(conversationId),
    db
      .prepare(`DELETE FROM conversations WHERE id = ? AND user_id = ?`)
      .bind(conversationId, userId)
  ]);

  return true;
}
