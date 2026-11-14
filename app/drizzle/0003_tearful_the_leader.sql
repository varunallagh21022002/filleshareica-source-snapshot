CREATE TABLE `market_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`google_subject` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`paid_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_accounts_google_subject_unique` ON `market_accounts` (`google_subject`);--> statement-breakpoint
CREATE TABLE `market_ad_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`ready_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `market_ad_attempts_expiry_idx` ON `market_ad_attempts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `market_device_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`replaced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`device_class` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `market_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_devices_slot_idx` ON `market_devices` (`account_id`,`device_class`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `market_devices_account_idx` ON `market_devices` (`account_id`);--> statement-breakpoint
CREATE TABLE `market_grants` (
	`order_id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `market_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `market_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_grants_payment_id_unique` ON `market_grants` (`payment_id`);--> statement-breakpoint
CREATE TABLE `market_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`key_thumbprint` text NOT NULL,
	`public_key_json` text NOT NULL,
	`device_class` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`ad_until` integer DEFAULT 0 NOT NULL,
	`grace_until` integer DEFAULT 0 NOT NULL,
	`last_grace_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `market_nonces_expiry_idx` ON `market_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `market_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`months` integer NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	`checkout_session_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `market_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `market_orders_account_idx` ON `market_orders` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `market_payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `market_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `market_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`authenticated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `market_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `market_sessions_expiry_idx` ON `market_sessions` (`expires_at`);