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
