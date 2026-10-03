CREATE TABLE `shell_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shell_rules_project_idx` ON `shell_rules` (`project_id`);--> statement-breakpoint
CREATE TABLE `workspace_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`project_id` text NOT NULL,
	`message_seq` integer NOT NULL,
	`message_id` text,
	`tool_call_id` text,
	`batch_id` text,
	`kind` text NOT NULL,
	`tool` text,
	`path` text,
	`command` text,
	`before_state` text,
	`before_sha` text,
	`before_size` integer,
	`before_mode` integer,
	`after_sha` text,
	`after_size` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_changes_chat_path_idx` ON `workspace_changes` (`chat_id`,`path`,`id`);--> statement-breakpoint
CREATE INDEX `workspace_changes_chat_seq_idx` ON `workspace_changes` (`chat_id`,`message_seq`);--> statement-breakpoint
CREATE INDEX `workspace_changes_project_idx` ON `workspace_changes` (`project_id`,`id`);--> statement-breakpoint
CREATE INDEX `workspace_changes_before_sha_idx` ON `workspace_changes` (`before_sha`);