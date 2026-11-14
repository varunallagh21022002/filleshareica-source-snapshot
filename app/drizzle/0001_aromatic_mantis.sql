ALTER TABLE `sessions` ADD `session_name` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `connection_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_slug_idx` ON `sessions` (`slug`);--> statement-breakpoint
ALTER TABLE `signals` ADD `connection_revision` integer DEFAULT 0 NOT NULL;