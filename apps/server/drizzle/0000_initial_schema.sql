CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`title_source` text,
	`model_ref` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`pending_approval` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chats_list_idx` ON `chats` (`archived`,"updated_at" DESC,"id" DESC);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `files_sha256_idx` ON `files` (`sha256`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`policy` text DEFAULT 'ask' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`search_text` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_seq_idx` ON `messages` (`chat_id`,`seq`);--> statement-breakpoint
CREATE TABLE `model_cache` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`fetched_at` integer,
	`attempted_at` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `model_prefs` (
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`hidden` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`alias` text,
	`custom` integer DEFAULT false NOT NULL,
	`info` text,
	`last_used_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider_id`, `model_id`)
);
--> statement-breakpoint
CREATE TABLE `plugin_kv` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `plugin_settings` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`values` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`version` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trusted_hash` text,
	`loading_since` integer,
	`last_error` text,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`status` text,
	`last_error` text,
	`validated_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`scope` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`hint` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `name`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_prefs` (
	`tool_name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`override` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`message_id` text,
	`purpose` text DEFAULT 'chat' NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`input` integer DEFAULT 0 NOT NULL,
	`output` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`cache_read` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_chat_idx` ON `usage` (`chat_id`);--> statement-breakpoint
CREATE INDEX `usage_created_idx` ON `usage` (`created_at`);