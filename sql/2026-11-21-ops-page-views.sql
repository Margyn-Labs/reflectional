-- Margyn — Ops: page views (which page, how long), for the Team logins view
-- 2026-11-21
--
-- Additive only. Safe to re-run. Run once in the Supabase SQL Editor.
-- Adds one event name, 'page_view', to the product_events allowlist (supersedes
-- the list in 2026-10-29-ops-investor-funnel.sql). Its properties are a page key,
-- the page before it, and seconds spent there (api/_lib/eventSchema.js): no
-- amounts, names or text. Until this runs, page views are simply not stored;
-- nothing else is affected.

alter table public.product_events drop constraint if exists product_events_name_allowlist;
alter table public.product_events add constraint product_events_name_allowlist check (name in (
  'app_open',
  'connector_sync_manual',
  'reconcile_run',
  'reconcile_summary_view',
  'mismatch_opened',
  'mismatch_resolved_marked',
  'ask_message_sent',
  'whatsapp_inbound',
  'whatsapp_outbound',
  'tally_agent_sync',
  'briefing_opened',
  'question_asked',
  'watch_sent',
  'page_view',
  'zoho_connect_started',
  'zoho_callback',
  'zoho_org_selected',
  'zoho_sync',
  'zoho_gstr2b_sync'
));

-- Faster per-person reads for the Ops Console (props.by = the team member who did it).
create index if not exists product_events_props_by_idx on public.product_events ((props->>'by'), at) where props ? 'by';

-- Check (should list page_view):
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'product_events_name_allowlist';
