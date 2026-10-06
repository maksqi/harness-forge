CREATE TABLE `marketplaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`resolved_ref` text,
	`catalog` text,
	`fetched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketplaces_name_unique` ON `marketplaces` (`name`);--> statement-breakpoint
ALTER TABLE `hooks` ADD `type` text DEFAULT 'command' NOT NULL;--> statement-breakpoint
ALTER TABLE `hooks` ADD `prompt` text;--> statement-breakpoint
ALTER TABLE `hooks` ADD `model` text;--> statement-breakpoint
ALTER TABLE `hooks` ADD `options` text;--> statement-breakpoint
ALTER TABLE `plugins` ADD `format` text DEFAULT 'harness' NOT NULL;--> statement-breakpoint
ALTER TABLE `plugins` ADD `origin` text;