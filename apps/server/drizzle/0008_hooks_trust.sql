CREATE TABLE `hooks` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`matcher` text,
	`command` text NOT NULL,
	`timeout` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_trust` (
	`project_id` text NOT NULL,
	`sha256` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `sha256`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `output_style` text;