CREATE TABLE `group_links` (
	`session_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`host_member_id` text NOT NULL,
	`guest_member_id` text NOT NULL,
	`host_token` text NOT NULL,
	`guest_token` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`) REFERENCES `group_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_member_id`) REFERENCES `group_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guest_member_id`) REFERENCES `group_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_links_pair_idx` ON `group_links` (`room_id`,`host_member_id`,`guest_member_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `group_rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_room_idx` ON `group_members` (`room_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_token_idx` ON `group_members` (`room_id`,`token_hash`);--> statement-breakpoint
CREATE TABLE `group_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`session_name` text,
	`join_hash` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_rooms_code_idx` ON `group_rooms` (`code`);--> statement-breakpoint
CREATE INDEX `group_rooms_expiry_idx` ON `group_rooms` (`expires_at`);