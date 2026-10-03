-- 2026-10-04: Margyn's updates on time, and "See details" for the short WhatsApp template.
-- Run once in Supabase → SQL Editor. Safe to run again.
--
-- 1. cron_runs     : "this job already ran today" (api/_lib/cronOnce.js), so the on-time Supabase call and the
--                    late Vercel call never both send.
-- 2. watch_pending : the full update waiting for the owner to tap See details (api/_lib/margynWatch.js).
-- 3. pg_cron jobs  : call the WhatsApp jobs on the minute (07:30, 10:30, 19:00 IST) instead of "some time in
--                    that hour" (Vercel Hobby), and refresh Razorpay / Cashfree / Zoho / Odoo / Shopify twice more
--                    a day (13:00 and 18:15 IST) instead of only at 02:00.
--
-- BEFORE RUNNING: replace PASTE_CRON_SECRET_HERE (one place, step 3) with the CRON_SECRET value from Vercel.

-- 1 + 2: tables (server-only: RLS on, no policies, so only the service role can read or write them)
create table if not exists public.cron_runs (
  job  text not null,
  day  date not null,
  at   timestamptz not null default now(),
  primary key (job, day)
);
alter table public.cron_runs enable row level security;

create table if not exists public.watch_pending (
  phone      text primary key,
  user_id    uuid,
  text       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.watch_pending enable row level security;

-- 3: on-time calls
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The secret lives in Supabase Vault, not in the job text.
do $$
begin
  if exists (select 1 from vault.secrets where name = 'margyn_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'margyn_cron_secret'), 'PASTE_CRON_SECRET_HERE');
  else
    perform vault.create_secret('PASTE_CRON_SECRET_HERE', 'margyn_cron_secret');
  end if;
end $$;

create or replace function public.margyn_call(path text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select net.http_get(
    url := 'https://www.margynlabs.com' || path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'margyn_cron_secret')),
    timeout_milliseconds := 60000
  );
$$;
revoke all on function public.margyn_call(text) from public, anon, authenticated;

-- Times are UTC (India = UTC + 5:30).
select cron.unschedule(jobname) from cron.job where jobname like 'margyn-%';

select cron.schedule('margyn-morning-0730ist', '0 2 * * *',   $$select public.margyn_call('/api/whatsapp?action=cron-opening')$$);
select cron.schedule('margyn-midday-1030ist',  '0 5 * * *',   $$select public.margyn_call('/api/whatsapp?action=cron-chase')$$);
select cron.schedule('margyn-evening-1900ist', '30 13 * * *', $$select public.margyn_call('/api/whatsapp?action=cron-closing')$$);

-- Online connectors: 13:00 and 18:15 IST (the 02:00 nightly run stays on Vercel).
select cron.schedule('margyn-sync-razorpay-1300ist', '30 7 * * *',  $$select public.margyn_call('/api/sync-razorpay?action=cron')$$);
select cron.schedule('margyn-sync-cashfree-1300ist', '32 7 * * *',  $$select public.margyn_call('/api/sync-razorpay?action=cashfree-cron')$$);
select cron.schedule('margyn-sync-zoho-1300ist',     '34 7 * * *',  $$select public.margyn_call('/api/zoho?action=cron')$$);
select cron.schedule('margyn-sync-odoo-1300ist',     '36 7 * * *',  $$select public.margyn_call('/api/zoho?action=odoo-cron')$$);
select cron.schedule('margyn-sync-shopify-1300ist',  '38 7 * * *',  $$select public.margyn_call('/api/shopify?action=cron')$$);
select cron.schedule('margyn-sync-razorpay-1815ist', '45 12 * * *', $$select public.margyn_call('/api/sync-razorpay?action=cron')$$);
select cron.schedule('margyn-sync-cashfree-1815ist', '47 12 * * *', $$select public.margyn_call('/api/sync-razorpay?action=cashfree-cron')$$);
select cron.schedule('margyn-sync-zoho-1815ist',     '49 12 * * *', $$select public.margyn_call('/api/zoho?action=cron')$$);
select cron.schedule('margyn-sync-odoo-1815ist',     '51 12 * * *', $$select public.margyn_call('/api/zoho?action=odoo-cron')$$);
select cron.schedule('margyn-sync-shopify-1815ist',  '53 12 * * *', $$select public.margyn_call('/api/shopify?action=cron')$$);

-- Check: should list 13 margyn-* jobs.
select jobname, schedule from cron.job where jobname like 'margyn-%' order by jobname;
