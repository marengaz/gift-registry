ALTER TABLE lists ADD COLUMN deleted_at INTEGER;
--> statement-breakpoint
DROP INDEX lists_recipient_occasion_unique;
--> statement-breakpoint
DROP INDEX lists_recipient_general_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX lists_recipient_occasion_unique ON lists (recipient_id, occasion) WHERE occasion IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX lists_recipient_general_unique ON lists (recipient_id) WHERE occasion IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE list_deletion_receipts (
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (actor_id, operation_id)
);
