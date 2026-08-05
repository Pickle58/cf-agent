-- Scope conversations to Clerk user ids. Pre-auth anonymous rows are discarded.

PRAGMA foreign_keys = OFF;

DELETE FROM messages;
DELETE FROM conversations;

CREATE TABLE conversations_new (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

INSERT INTO conversations_new (id, user_id, created_at, updated_at)
SELECT id, 'legacy', created_at, updated_at FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX IF NOT EXISTS conversations_by_user_updated
ON conversations (user_id, updated_at DESC);

PRAGMA foreign_keys = ON;
