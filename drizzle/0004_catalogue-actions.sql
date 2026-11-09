ALTER TABLE products ADD COLUMN deleted_at INTEGER;
--> statement-breakpoint
ALTER TABLE products ADD COLUMN deletion_token TEXT;
--> statement-breakpoint
CREATE TABLE catalogue_actions (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'delete', 'undo')),
  snapshots_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  undone_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX catalogue_actions_actor_operation_unique ON catalogue_actions (actor_id, operation_id);
--> statement-breakpoint
CREATE TABLE catalogue_latest_actions (
  actor_id TEXT PRIMARY KEY NOT NULL,
  action_id TEXT NOT NULL REFERENCES catalogue_actions(id) ON DELETE RESTRICT
);
