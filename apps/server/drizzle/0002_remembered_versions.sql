ALTER TABLE `messages` ADD `selected_child_id` text;--> statement-breakpoint
-- Hand-written backfill (ADR-030): along each chat's active path, every message remembers the child that is shown under
-- it, so switching away from a version and back restores the path that was shown. Messages off the active path keep
-- null (= the latest leaf under them), which is what v1.1 did for every switch.
WITH RECURSIVE path(chat_id, id, parent_id, seq) AS (
  SELECT m.`chat_id`, m.`id`, m.`parent_id`, m.`seq` FROM `chats` c
    JOIN `messages` m ON m.`chat_id` = c.`id` AND m.`id` = c.`active_leaf_id`
  UNION ALL
  SELECT p.`chat_id`, p.`id`, p.`parent_id`, p.`seq` FROM `messages` p
    JOIN path ON p.`id` = path.parent_id AND p.`chat_id` = path.chat_id AND p.`seq` < path.seq
)
UPDATE `messages` SET `selected_child_id` = path.id FROM path
  WHERE `messages`.`id` = path.parent_id AND `messages`.`chat_id` = path.chat_id;
