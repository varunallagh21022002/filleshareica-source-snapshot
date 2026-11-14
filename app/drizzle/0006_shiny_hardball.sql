CREATE TABLE `market_offline_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`event_hash` text NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`credit_id` text,
	`settled_at` integer,
	`settlement_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_offline_send_owner_idx` ON `market_offline_sends` (`installation_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `market_offline_send_pending_idx` ON `market_offline_sends` (`installation_id`,`status`,`verified_at`);--> statement-breakpoint
CREATE TABLE `market_send_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`status` text NOT NULL,
	`operation_id` text,
	`created_at` integer NOT NULL,
	`spent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_send_one_ready_credit_idx` ON `market_send_credits` (`installation_id`) WHERE status='ready';--> statement-breakpoint
CREATE INDEX `market_send_credit_owner_idx` ON `market_send_credits` (`installation_id`,`status`);--> statement-breakpoint
CREATE TABLE `market_send_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`intent_json` text,
	`intent_hash` text,
	`decision` text,
	`credit_id` text,
	`status` text DEFAULT 'prepared' NOT NULL,
	`created_at` integer NOT NULL,
	`verified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_send_operation_owner_idx` ON `market_send_operations` (`installation_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `market_send_states` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`premium_cutoff` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `market_ad_attempts` ADD `purpose` text;--> statement-breakpoint
ALTER TABLE `market_ad_attempts` ADD `operation_id` text;--> statement-breakpoint
ALTER TABLE `market_ad_attempts` ADD `completion_id` text;