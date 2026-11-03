CREATE TABLE `allocation_history` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action_id` text NOT NULL,
	`action` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`from_buyer_id` text,
	`to_buyer_id` text,
	`resulting_version` integer NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_actor_action_unique` ON `allocation_history` (`actor_id`,`action_id`);--> statement-breakpoint
CREATE INDEX `allocation_entry_index` ON `allocation_history` (`entry_id`);--> statement-breakpoint
CREATE TABLE `capture_receipts` (
	`actor_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`product_id` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`actor_id`, `operation_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`list_id` text NOT NULL,
	`estimate_pence` integer,
	`actual_pence` integer,
	`state` text DEFAULT 'available' NOT NULL,
	`buyer_id` text,
	`allocation_source` text,
	`allocated_by_id` text,
	`allocated_at` integer,
	`purchased_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "entries_estimate_integer_pence" CHECK("entries"."estimate_pence" IS NULL OR (typeof("entries"."estimate_pence") = 'integer' AND "entries"."estimate_pence" >= 0)),
	CONSTRAINT "entries_actual_integer_pence" CHECK("entries"."actual_pence" IS NULL OR (typeof("entries"."actual_pence") = 'integer' AND "entries"."actual_pence" >= 0)),
	CONSTRAINT "entries_version_nonnegative" CHECK(typeof("entries"."version") = 'integer' AND "entries"."version" >= 0),
	CONSTRAINT "entries_allocation_consistent" CHECK((
    "entries"."state" = 'available' AND "entries"."buyer_id" IS NULL AND "entries"."allocation_source" IS NULL AND "entries"."allocated_by_id" IS NULL AND "entries"."actual_pence" IS NULL
  ) OR (
    "entries"."state" IN ('allocated', 'purchased') AND "entries"."buyer_id" IS NOT NULL AND "entries"."allocated_by_id" IS NOT NULL AND "entries"."allocation_source" IS NOT NULL AND "entries"."allocation_source" IN ('self', 'administrator') AND ("entries"."state" = 'purchased' OR "entries"."actual_pence" IS NULL)
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_product_list_unique` ON `entries` (`product_id`,`list_id`);--> statement-breakpoint
CREATE INDEX `entries_list_index` ON `entries` (`list_id`);--> statement-breakpoint
CREATE INDEX `entries_buyer_index` ON `entries` (`buyer_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_unique` ON `labels` (`name`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`name` text NOT NULL,
	`occasion` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "lists_occasion_not_empty" CHECK("lists"."occasion" IS NULL OR length(trim("lists"."occasion")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_recipient_occasion_unique` ON `lists` (`recipient_id`,`occasion`) WHERE "lists"."occasion" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `lists_recipient_general_unique` ON `lists` (`recipient_id`) WHERE "lists"."occasion" IS NULL;--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`storage_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`original_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_size_nonnegative" CHECK(typeof("media"."byte_size") = 'integer' AND "media"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_storage_path_unique` ON `media` (`storage_path`);--> statement-breakpoint
CREATE INDEX `media_product_index` ON `media` (`product_id`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`url` text NOT NULL,
	`retailer` text,
	`price_minor` integer,
	`currency` text,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "offers_price_integer_minor" CHECK("offers"."price_minor" IS NULL OR (typeof("offers"."price_minor") = 'integer' AND "offers"."price_minor" >= 0 AND "offers"."currency" IS NOT NULL)),
	CONSTRAINT "offers_currency_code" CHECK("offers"."currency" IS NULL OR "offers"."currency" GLOB '[A-Z][A-Z][A-Z]')
);
--> statement-breakpoint
CREATE INDEX `offers_product_index` ON `offers` (`product_id`);--> statement-breakpoint
CREATE TABLE `product_labels` (
	`product_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`product_id`, `label_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`variant` text,
	`source_url` text,
	`source_text` text,
	`contributor_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `products_contributor_index` ON `products` (`contributor_id`);--> statement-breakpoint
CREATE TABLE `recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
