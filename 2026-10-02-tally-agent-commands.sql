-- Remote commands for Tally agents (2026-10-02). Run in the Supabase SQL editor. Safe to re-run.
-- Lets Margyn send one-off instructions to a client's agent (0.2.4+) without access to their PC.
-- Delivered on the agent's next sync, then cleared.
alter table public.tally_installs add column if not exists agent_command jsonb;
alter table public.tally_installs add column if not exists diagnostics jsonb;

-- Examples (run only when needed):
--   Re-read the whole financial year from Tally for one client:
--     update public.tally_installs set agent_command = '{"action":"resync"}' where company_name ilike 'CARE HYGIENE%' and status = 'active';
--   Re-test how to read that client's Tally (after an agent fix):
--     update public.tally_installs set agent_command = '{"action":"recalibrate"}' where company_name ilike 'CARE HYGIENE%' and status = 'active';
--   Update every agent right now: set TALLY_AGENT_MIN_VERSION in Vercel to the new version (or bump
--   TALLY_AGENT_MIN_VERSION_DEFAULT in api/tally.js) after uploading the release to R2.
