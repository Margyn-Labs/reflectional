-- 2026-10-04: know whether each WhatsApp message actually arrived. No secrets, nothing to edit.
-- Run once in Supabase → SQL Editor. Safe to run again.
--
-- wa_deliveries : one row per message Margyn sends (updates, customer reminders) with WhatsApp's delivery
--                 report: delivered / read / failed + reason (api/_lib/waDeliveries.js).
-- watch_pending : the full update waiting for a "See details" tap (api/_lib/margynWatch.js).
-- cron_runs     : "this job already ran today" (api/_lib/cronOnce.js).
-- All server-only: RLS on and no policies, so only the service role reads or writes them.

create table if not exists public.wa_deliveries (
  message_id   text primary key,          -- Gupshup's message id
  wa_id        text,                      -- WhatsApp's own id, learned from the first report
  user_id      uuid,
  kind         text not null default 'watch',   -- watch | chase
  to_phone     text,
  sent_to      text,                      -- owner | preview | preview_copy | customer
  signal_keys  text[],
  ref          text,
  status       text not null default 'queued',  -- queued | accepted | sent | delivered | read | failed
  error_code   text,
  error        text,
  sent_at      timestamptz not null default now(),
  delivered_at timestamptz,
  read_at      timestamptz,
  failed_at    timestamptz
);
create index if not exists wa_deliveries_wa_id on public.wa_deliveries (wa_id);
create index if not exists wa_deliveries_user on public.wa_deliveries (user_id, sent_at desc);
alter table public.wa_deliveries enable row level security;

create table if not exists public.watch_pending (
  phone      text primary key,
  user_id    uuid,
  text       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.watch_pending enable row level security;

create table if not exists public.cron_runs (
  job  text not null,
  day  date not null,
  at   timestamptz not null default now(),
  primary key (job, day)
);
alter table public.cron_runs enable row level security;

-- Check: should return 3 rows.
select table_name from information_schema.tables where table_schema = 'public' and table_name in ('wa_deliveries', 'watch_pending', 'cron_runs');
