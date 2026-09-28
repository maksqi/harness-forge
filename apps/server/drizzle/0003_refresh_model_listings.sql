-- Hand-written (Phase 6, ADR-028 / ADR-029): v1.2 changes what a provider listing contains (media model ids with their
-- kinds, image output from the listing's output modalities, new seed models of the builtin plugins). A listing cached by
-- v1.1 would hide those for up to 24 hours, so every successful cached listing is aged by one listing TTL (24 h): it
-- stays the last good listing the catalog serves, and it is stale, so the next start or background cycle refreshes it
-- (a failed refresh keeps it). Rows without a successful fetch (`fetched_at` null) stay as they are.
UPDATE `model_cache` SET `fetched_at` = `fetched_at` - 86400000 WHERE `fetched_at` IS NOT NULL;
