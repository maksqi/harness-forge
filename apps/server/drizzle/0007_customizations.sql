CREATE TABLE `background_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`output` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`delivered_at` integer,
	`delivered_message_id` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `background_tasks_chat_idx` ON `background_tasks` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `background_tasks_pending_idx` ON `background_tasks` (`delivered_at`,`status`);--> statement-breakpoint
CREATE TABLE `customizations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customizations_kind_name_uq` ON `customizations` (`kind`,`name`);