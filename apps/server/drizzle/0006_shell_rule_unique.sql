-- Hand-written (Phase 9, ADR-038 amendment): v1.4 serialized shell rule creation only inside one process, so a scope
-- could hold the same prefix twice. Keep the oldest rule of each (scope, prefix) group (by created_at, then id) and
-- delete the rest before the partial unique indexes below make the database the authority. A null project_id is the
-- global scope.
DELETE FROM `shell_rules` WHERE `id` IN (
  SELECT r.`id` FROM `shell_rules` r JOIN `shell_rules` k
    ON coalesce(k.`project_id`, '') = coalesce(r.`project_id`, '') AND k.`prefix` = r.`prefix`
   AND (k.`created_at` < r.`created_at` OR (k.`created_at` = r.`created_at` AND k.`id` < r.`id`))
);--> statement-breakpoint
-- Hand-written (Phase 9): since v1.4 the server refuses an `allow` override on execute tools and ignores a stored one;
-- clear the one a v1.3 install may have stored on `shell` so `GET /tools` stops showing it. Other overrides stay.
UPDATE `tool_prefs` SET `override` = NULL WHERE `tool_name` = 'shell' AND `override` = 'allow';--> statement-breakpoint
CREATE UNIQUE INDEX `shell_rules_global_prefix_uq` ON `shell_rules` (`prefix`) WHERE project_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX `shell_rules_project_prefix_uq` ON `shell_rules` (`project_id`,`prefix`) WHERE project_id is not null;