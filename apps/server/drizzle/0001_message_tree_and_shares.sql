CREATE TABLE `chat_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`title` text,
	`options` text NOT NULL,
	`snapshot` text NOT NULL,
	`file_ids` text DEFAULT '[]' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`snapshot_at` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_shares_chat_idx` ON `chat_shares` (`chat_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `active_leaf_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `messages_chat_parent_idx` ON `messages` (`chat_id`,`parent_id`);--> statement-breakpoint
-- Hand-written backfill (ADR-023): v1 chats are linear, so every message's parent is the previous message by seq and
-- the active leaf is the last message (null for an empty chat).
UPDATE `messages` SET `parent_id` = (SELECT p.`id` FROM `messages` p WHERE p.`chat_id` = `messages`.`chat_id`
  AND p.`seq` < `messages`.`seq` ORDER BY p.`seq` DESC LIMIT 1);--> statement-breakpoint
UPDATE `chats` SET `active_leaf_id` = (SELECT m.`id` FROM `messages` m WHERE m.`chat_id` = `chats`.`id`
  ORDER BY m.`seq` DESC LIMIT 1);
