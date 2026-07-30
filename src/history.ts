import type { UIMessage } from "ai";

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  payload: string;
  created_at: number;
};

/**
 * Ensure a conversation row exists and refresh its updated_at timestamp.
 */
export async function upsertConversation(
  db: D1Database,
  conversationId: string,
  updatedAt = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversations (id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .bind(conversationId, updatedAt, updatedAt)
    .run();
}

/**
 * Idempotently mirror the full message list for a conversation into D1.
 * Existing message IDs are upserted; rows not present in `messages` are removed
 * so clears and truncations stay consistent with the live agent transcript.
 */
export async function syncConversationMessages(
  db: D1Database,
  conversationId: string,
  messages: UIMessage[]
): Promise<void> {
  const now = Date.now();
  await upsertConversation(db, conversationId, now);

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
 * Load archived messages for a conversation, oldest first.
 */
export async function listConversationMessages(
  db: D1Database,
  conversationId: string
): Promise<UIMessage[]> {
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
 * Delete a conversation and all of its archived messages.
 */
export async function deleteConversation(
  db: D1Database,
  conversationId: string
): Promise<void> {
  await db.batch([
    db
      .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
      .bind(conversationId),
    db.prepare(`DELETE FROM conversations WHERE id = ?`).bind(conversationId)
  ]);
}
