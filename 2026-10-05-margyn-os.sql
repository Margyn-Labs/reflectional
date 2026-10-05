-- ============================================================
-- Margyn OS (5 Oct 2026): threads and assignments on records.
--
-- One append-only table. A row is either
--   * a comment on a customer/supplier page (record_type 'party'), or
--   * an assignment of a piece of work to a person (record_type 'work',
--     kind 'assign'); the newest assign row for an item is who owns it.
-- Nothing is updated or deleted: like the ledger, the history is the record.
--
-- Access follows the team rules (2026-09-29-team-logins.sql):
--   read  = the owner, or any active member of the account ('view')
--   write = the same people, and only under their own name (author_id = auth.uid())
-- So a read-only CA can comment and be assigned work, but can't change figures.
--
-- Safe to run twice. Run it in the Supabase SQL editor.
-- ============================================================

create table if not exists public.record_notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,   -- the account (the owner's id)
  record_type  text not null check (record_type in ('party', 'work')),
  record_key   text not null,                                              -- party key, or a work item key
  kind         text not null default 'comment' check (kind in ('comment', 'assign')),
  body         text check (body is null or char_length(body) <= 4000),
  assignee     text check (assignee is null or char_length(assignee) <= 200),
  author_id    uuid not null default auth.uid(),
  author_name  text check (author_name is null or char_length(author_name) <= 200),
  created_at   timestamptz not null default now()
);
create index if not exists record_notes_lookup on public.record_notes (user_id, record_type, record_key, created_at desc);

alter table public.record_notes enable row level security;

drop policy if exists record_notes_select on public.record_notes;
create policy record_notes_select on public.record_notes for select
  using (public.mg_member_can(user_id, 'view'));

drop policy if exists record_notes_insert on public.record_notes;
create policy record_notes_insert on public.record_notes for insert
  with check (public.mg_member_can(user_id, 'view') and author_id = auth.uid());

-- No update or delete policy: rows can't be changed or removed from the app.

-- Check (should list 2 policies):
-- select policyname, cmd from pg_policies where tablename = 'record_notes';

-- ============================================================
-- Write-back (5 Oct 2026): what an approval should change in your apps.
--
-- app_writes: one row per change Margyn should make in Zoho, Tally, Odoo,
-- Razorpay or Cashfree after someone approves something. The server queues
-- and sends them (api/_lib/writeBack.js); the app shows each one's status:
--   queued -> writing -> confirmed (the next sync saw it) | failed
--   waiting_access: that app isn't writable yet; it is saved in Margyn.
-- app_write_access: per account and app, whether the customer has given
-- Margyn write permission (filled in when they reconnect an app with it).
--
-- Only the server writes these tables (service role). The team can read them.
-- Safe to run twice.
-- ============================================================

create table if not exists public.app_writes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,   -- the account
  app              text not null check (app in ('zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify')),
  action           text not null check (char_length(action) <= 40),
  source_type      text not null check (source_type in ('agent_action', 'recon_match', 'suggestion')),
  source_id        text not null,
  ref              text not null default '',
  summary          text check (summary is null or char_length(summary) <= 300),
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in ('queued', 'waiting_access', 'writing', 'confirmed', 'failed', 'cancelled')),
  status_note      text check (status_note is null or char_length(status_note) <= 400),
  external_ref     text,
  attempts         int not null default 0,
  approved_by      uuid,
  approved_by_name text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  unique (user_id, app, action, source_type, source_id, ref)
);
create index if not exists app_writes_open on public.app_writes (user_id, status, created_at desc);

create table if not exists public.app_write_access (
  user_id    uuid not null references auth.users(id) on delete cascade,
  app        text not null check (app in ('zoho', 'tally', 'odoo', 'razorpay', 'cashfree', 'shopify')),
  enabled    boolean not null default false,
  scopes     text,
  granted_at timestamptz,
  primary key (user_id, app)
);

alter table public.app_writes enable row level security;
alter table public.app_write_access enable row level security;

drop policy if exists app_writes_select on public.app_writes;
create policy app_writes_select on public.app_writes for select using (public.mg_member_can(user_id, 'view'));
drop policy if exists app_write_access_select on public.app_write_access;
create policy app_write_access_select on public.app_write_access for select using (public.mg_member_can(user_id, 'view'));
-- No insert/update/delete policies: only the server changes these.

-- Check (should list 4 policies across the three tables):
-- select tablename, policyname from pg_policies where tablename in ('record_notes', 'app_writes', 'app_write_access');
