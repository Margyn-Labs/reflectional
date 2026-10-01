-- Tally agent health reports (2026-10-02). Run in the Supabase SQL editor. Safe to re-run.
-- The 0.2.0 agent reports what it sees in the client's Tally after every sync: product/version,
-- open companies, books period, which voucher request works on that Tally, and per-month voucher
-- counts against Tally's own. Margyn uses it to prove completeness and to diagnose a client's sync
-- without access to their machine. Until this runs, the agent still syncs; reports are just dropped.
alter table public.tally_installs add column if not exists diagnostics jsonb;
