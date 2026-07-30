-- Durable/queryable archive of AIChatAgent conversations.
-- Live streaming still uses Durable Object SQLite; D1 mirrors completed turns.

CREATE TABLE IF NOT EXISTS conversations (
	id TEXT PRIMARY KEY NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY NOT NULL,
	conversation_id TEXT NOT NULL,
	role TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS messages_by_conversation_created
ON messages (conversation_id, created_at);
