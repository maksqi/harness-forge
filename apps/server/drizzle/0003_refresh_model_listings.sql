-- Hand-written (Phase 6, ADR-028 / ADR-029): v1.2 changes what a provider listing contains (media model ids with their
-- kinds, image output from the listing's output modalities, new seed models of the builtin plugins). A listing cached by
-- v1.1 would hide those for up to 24 hours, so every cached listing is marked stale once: the catalog keeps showing it
-- and refreshes it at the next start or background cycle (a failed refresh keeps the last good listing).
UPDATE `model_cache` SET `fetched_at` = NULL;
