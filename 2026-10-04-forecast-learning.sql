-- Forecast that learns (api/_lib/forecastStore.js), 2026-10-04.
-- One forecast per account per day, and the end-of-day position, so Margyn can grade its own forecasts.
-- Safe to run more than once. The app works without it (no track record until it's run).
create table if not exists forecast_runs (
  user_id uuid not null,
  run_date date not null,
  opening numeric,
  daily_close jsonb, daily_low jsonb, daily_high jsonb,
  weeks jsonb, parts jsonb, drivers jsonb, self_check jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, run_date)
);
create table if not exists daily_positions (
  user_id uuid not null,
  date date not null,
  cash numeric, receivables numeric, payables numeric,
  recorded_at timestamptz default now(),
  primary key (user_id, date)
);
-- Only the server (service role) reads and writes these; nobody signs in to them directly.
alter table forecast_runs enable row level security;
alter table daily_positions enable row level security;
