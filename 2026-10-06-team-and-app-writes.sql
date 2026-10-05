-- ============================================================
-- Team threads and assignments (6 Oct 2026): comments on a customer or supplier, and who owns each Inbox item.
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
-- Write-back (6 Oct 2026): what an approval should change in your apps.
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

-- ============================================================
-- Who is online (6 Oct 2026): a private Realtime channel per account.
--
-- The app joins the channel 'team-<account id>' to show who else is in
-- Margyn, which page or customer they have open and whether they are typing.
-- It is a PRIVATE channel: only the account's owner and its active members
-- may listen or announce themselves. Until this runs, the app simply doesn't
-- show who is online.
-- ============================================================

drop policy if exists team_channel_listen on realtime.messages;
create policy team_channel_listen on realtime.messages for select to authenticated
  using (case when realtime.topic() ~ '^team-[0-9a-f-]{36}$'
              then public.mg_member_can(substring(realtime.topic() from 6)::uuid, 'view')
              else false end);

drop policy if exists team_channel_send on realtime.messages;
create policy team_channel_send on realtime.messages for insert to authenticated
  with check (case when realtime.topic() ~ '^team-[0-9a-f-]{36}$'
                   then public.mg_member_can(substring(realtime.topic() from 6)::uuid, 'view')
                   else false end);

-- Check (should list 2 policies):
-- select policyname, cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'team_channel%';
