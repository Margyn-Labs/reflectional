-- Books health check (2026-10-07). Run once in the Supabase SQL editor. Safe to re-run.
--
-- books_health: what's wrong in each account's books that the accountant should fix (interest filed as income,
-- a month's costs not booked, paid bills still open, cash below zero, ...). Margyn checks every account with
-- books each morning (with the 07:30 Margyn Watch run) and keeps one row per finding, with a stable key:
--   open    -> found on the latest check
--   fixed   -> a later check no longer finds it (closes by itself)
--   ignored -> the owner said leave it; raised again only if its amount moves more than 25%
-- One extra row per account (key 'run:last', status 'meta') records when the last check ran.
-- Written only by the server (service role, api/_lib/booksHealth.js and api/tally.js); the owner reads their own rows.

create table if not exists public.books_health (
  user_id         uuid not null references auth.users(id) on delete cascade,
  key             text not null,                 -- stable per finding, e.g. 'supplier_bills_settled:sanjay plastics', 'costs_not_booked:2026-09'
  kind            text not null,                 -- interest_under_income, costs_not_booked, name_vs_group, cash_negative, ... or 'run'
  area            text,                          -- books | cash | customers | suppliers (what a team member's access covers)
  source          text,                          -- tally | zoho | odoo
  status          text not null default 'open' check (status in ('open', 'fixed', 'ignored', 'meta')),
  severity        text,                          -- high | medium | low
  title           text,
  detail          text,
  fix             text,                          -- what the accountant should do
  party           text,
  ledger          text,
  amount          numeric,                       -- rupees, for "has it moved more than 25%"
  ignored_amount  numeric,                       -- the amount when the owner ignored it
  for_accountant  boolean not null default true, -- false = for information only (not in the accountant's list)
  data            jsonb,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  fixed_at        timestamptz,
  ignored_at      timestamptz,
  ignored_by      text,
  reopened_at     timestamptz,
  primary key (user_id, key)
);

alter table public.books_health enable row level security;

drop policy if exists books_health_select_own on public.books_health;
create policy books_health_select_own on public.books_health
  for select using (auth.uid() = user_id);
-- no insert/update/delete policy: the server (service role) owns all writes, including "Ignore" from the app.

create index if not exists books_health_user_status on public.books_health (user_id, status);
