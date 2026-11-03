CREATE TABLE `allowance_reservations` (
	`job_id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`amount_microdollars` integer NOT NULL,
	`pricing_revision` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `lookup_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "allowance_amount_positive" CHECK(typeof("allowance_reservations"."amount_microdollars")='integer' AND "allowance_reservations"."amount_microdollars">0)
);
--> statement-breakpoint
CREATE INDEX `allowance_month_index` ON `allowance_reservations` (`month`);--> statement-breakpoint
CREATE TABLE `identification_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`monthly_limit_microdollars` integer DEFAULT 1000000 NOT NULL,
	`unit_microdollars` integer DEFAULT 3500 NOT NULL,
	`pricing_revision` text DEFAULT 'vision-web-2026-11' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "identification_singleton" CHECK("identification_settings"."id"=1),
	CONSTRAINT "identification_allowance_valid" CHECK(typeof("identification_settings"."monthly_limit_microdollars")='integer' AND "identification_settings"."monthly_limit_microdollars">=0 AND typeof("identification_settings"."unit_microdollars")='integer' AND "identification_settings"."unit_microdollars">=3500)
);
--> statement-breakpoint
CREATE TABLE `lookup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`kind` text NOT NULL,
	`media_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`started_at` integer,
	`lease_until` integer,
	`dispatched_at` integer,
	`finished_at` integer,
	`result_json` text,
	`error_text` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lookup_actor_operation_unique` ON `lookup_jobs` (`actor_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `lookup_product_index` ON `lookup_jobs` (`product_id`);--> statement-breakpoint
CREATE INDEX `lookup_state_index` ON `lookup_jobs` (`state`);