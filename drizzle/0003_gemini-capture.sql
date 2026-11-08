CREATE TABLE gemini_capture_requests (
  actor_id TEXT NOT NULL REFERENCES user(id),
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  month TEXT NOT NULL,
  evaluation INTEGER NOT NULL DEFAULT 0 CHECK(evaluation IN (0,1)),
  reserved_microdollars INTEGER NOT NULL CHECK(reserved_microdollars > 0),
  state TEXT NOT NULL CHECK(state IN ('running','complete','uncertain')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
--> statement-breakpoint
CREATE INDEX gemini_capture_month_index ON gemini_capture_requests(month);
