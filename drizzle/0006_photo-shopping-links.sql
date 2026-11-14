ALTER TABLE lookup_jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'vision' CHECK(provider IN ('vision','serpapi') AND (provider = 'vision' OR kind = 'vision'));
--> statement-breakpoint
CREATE TABLE serpapi_search_reservations (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES lookup_jobs(id) ON DELETE RESTRICT,
 month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
 created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX serpapi_search_month_index ON serpapi_search_reservations(month);
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN reverse_provider TEXT CHECK(reverse_provider IS NULL OR reverse_provider IN ('vision','serpapi'));
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN reverse_job_id TEXT;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN checked_at INTEGER;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN checked_by_id TEXT;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN checked_fingerprint TEXT CHECK(
 (checked_at IS NULL AND checked_by_id IS NULL AND checked_fingerprint IS NULL) OR
 (reverse_provider IS NOT NULL AND typeof(checked_at) = 'integer' AND checked_at > 0 AND checked_by_id IS NOT NULL AND checked_fingerprint IS NOT NULL)
);
--> statement-breakpoint
UPDATE offers SET reverse_provider = 'vision', reverse_job_id = (
 SELECT j.id FROM lookup_jobs j, json_each(CASE WHEN json_valid(j.result_json) THEN j.result_json ELSE '{}' END, '$.suggestions') candidate
 WHERE j.kind = 'vision' AND j.provider = 'vision' AND j.state = 'succeeded' AND j.product_id = offers.product_id
 AND offers.id = 'lookup-' || j.id || '-' || candidate.key
 AND candidate.key BETWEEN 0 AND 7 AND json_extract(candidate.value,'$.offer.url') = offers.url
 LIMIT 1
) WHERE EXISTS (
 SELECT 1 FROM lookup_jobs j, json_each(CASE WHEN json_valid(j.result_json) THEN j.result_json ELSE '{}' END, '$.suggestions') candidate
 WHERE j.kind = 'vision' AND j.provider = 'vision' AND j.state = 'succeeded' AND j.product_id = offers.product_id
 AND offers.id = 'lookup-' || j.id || '-' || candidate.key
 AND candidate.key BETWEEN 0 AND 7 AND json_extract(candidate.value,'$.offer.url') = offers.url
);
