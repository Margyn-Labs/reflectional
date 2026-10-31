-- 2026-10-31-on-time-crons.sql
-- WhatsApp updates on the minute, not "somewhere in the hour".
--
-- Why: Vercel Hobby runs each cron at some minute inside its hour, so the 10:30 update and the
-- customer reminders went out at ~11:09, the 7:30 morning update at ~8:12, the 7:00 pm one at ~7:19.
-- api/_lib/cronOnce.js (live since 4 Oct) already lets a second clock fire the same URLs: whichever
-- call arrives first claims the slot in cron_runs (job + India day), the other does nothing. This file
-- is that second clock: Supabase pg_cron calls the same URLs on the minute. Vercel's crons stay as the
-- backup, so if Supabase ever misses, the update still goes out (late), and never twice.
--
-- Run once in Supabase → SQL Editor. Before running, replace the 2 copies of the placeholder in the Vault block below
-- with the CRON_SECRET value from Vercel → reflectional → Settings → Environment Variables.
-- Safe to run again: it replaces the jobs and the stored secret.

-- Also (Zoho TDS, 31 Oct): Zoho's balance per account, so Margyn can say how much TDS customers deducted and you owe.
alter table public.zoho_chart_of_accounts add column if not exists current_balance numeric;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The run-once table cronOnce.js writes to (already there if earlier SQL made it; this is a no-op then).
create table if not exists public.cron_runs (
  job text not null,
  day date not null,
  at timestamptz not null default now(),
  primary key (job, day)
);
alter table public.cron_runs enable row level security;   -- server (service role) only

-- The secret lives in Supabase Vault, not in the job text.
do $$
begin
  if exists (select 1 from vault.secrets where name = 'margyn_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'margyn_cron_secret'), 'PASTE-CRON-SECRET-HERE');
  else
    perform vault.create_secret('PASTE-CRON-SECRET-HERE', 'margyn_cron_secret');
  end if;
end $$;

create or replace function public.margyn_call_cron(path text)
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_get(
    url := 'https://www.margynlabs.com' || path,
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'margyn_cron_secret')),
    timeout_milliseconds := 60000
  );
$$;
revoke all on function public.margyn_call_cron(text) from public, anon, authenticated;

-- Drop earlier copies of these jobs, then schedule them. Times are UTC (IST − 5:30).
select cron.unschedule(jobname) from cron.job where jobname like 'margyn-ontime-%';

select cron.schedule('margyn-ontime-morning',   '0 2 * * *',   $$select public.margyn_call_cron('/api/whatsapp?action=cron-opening')$$);            -- 07:30 IST
select cron.schedule('margyn-ontime-chase',     '0 5 * * *',   $$select public.margyn_call_cron('/api/whatsapp?action=cron-chase')$$);              -- 10:30 IST reminders + update
select cron.schedule('margyn-ontime-noon',      '0 7 * * *',   $$select public.margyn_call_cron('/api/whatsapp?action=cron-watch&slot=noon')$$);     -- 12:30 IST
select cron.schedule('margyn-ontime-afternoon', '30 9 * * *',  $$select public.margyn_call_cron('/api/whatsapp?action=cron-watch&slot=afternoon')$$);-- 15:00 IST
select cron.schedule('margyn-ontime-late',      '30 11 * * *', $$select public.margyn_call_cron('/api/whatsapp?action=cron-watch&slot=late')$$);     -- 17:00 IST
select cron.schedule('margyn-ontime-evening',   '30 13 * * *', $$select public.margyn_call_cron('/api/whatsapp?action=cron-closing')$$);            -- 19:00 IST

-- Check: should list 6 rows.
select jobname, schedule, active from cron.job where jobname like 'margyn-ontime-%' order by schedule;
