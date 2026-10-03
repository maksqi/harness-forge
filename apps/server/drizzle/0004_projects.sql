CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`instructions` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_idx` ON `projects` (`path`);--> statement-breakpoint
ALTER TABLE `chats` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `chats_project_idx` ON `chats` (`project_id`,`archived`,"updated_at" DESC,"id" DESC);