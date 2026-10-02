-- Margyn Watch + the question index (2026-10-03). Run once in the Supabase SQL editor. Safe to re-run.
--
-- 1. margyn_signals: every finding Margyn Watch has seen in an account's books (overdue money,
--    customers gone quiet, an unfinished month, GST due...), whether and how it was sent on
--    WhatsApp, and what the owner muted. Written only by the server (service role); the owner
--    reads their own rows in the Conversations hub.
-- 2. product_events: two new event names for the ops counters ('question_asked' with a topic and
--    an answered flag, never the words; 'watch_sent'). Without this the counters silently drop them.
-- 3. The Tally structure columns from 2026-10-02-tally-structure.sql, in case that file wasn't run.

create table if not exists public.margyn_signals (
  user_id      uuid not null references auth.users(id) on delete cascade,
  key          text not null,                  -- stable per finding, e.g. 'quiet:lupin ltd bhiwandi', 'gst:2026-09'
  kind         text not null,                  -- overdue_total, old_debts, late, quiet, gst_due, ... or a muted kind
  severity     text,                           -- high | medium | low
  impact       numeric,                        -- rupees, for "has it moved enough to say again"
  title        text,
  detail       text,
  action       text,
  ask          text,                           -- the follow-up question the hub offers as one tap
  status       text not null default 'open' check (status in ('open', 'sent', 'muted', 'resolved')),
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  last_sent_at timestamptz,
  sent_count   integer not null default 0,
  sent_via     text,                           -- session | template
  sent_to      text,                           -- owner | preview
  primary key (user_id, key)
);

alter table public.margyn_signals enable row level security;

drop policy if exists margyn_signals_select_own on public.margyn_signals;
create policy margyn_signals_select_own on public.margyn_signals
  for select using (auth.uid() = user_id);
-- no insert/update/delete policy: api/ask-margyn.js and api/whatsapp.js (service role) own all writes.

create index if not exists margyn_signals_user_seen on public.margyn_signals (user_id, last_seen desc);

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
  'watch_sent'
));

alter table public.tally_ledgers  add column if not exists primary_group text;
alter table public.tally_vouchers add column if not exists voucher_base  text;
