-- 2026-09-27 · Party master: one customer/vendor record, shared by every path
-- ---------------------------------------------------------------------------
-- ledger_parties (Invoicing › Parties) becomes the single customer/vendor
-- master. It is now created from the Customers and Vendors pages, by the AI
-- file import / WhatsApp import when a document names someone new, and by
-- Margyn (chat or voice) when it logs an invoice for a party that doesn't
-- exist yet. Every receivable/payable Margyn writes is linked to it by id.
--
-- The extra columns are what Tally (ledger under Sundry Debtors/Creditors:
-- name, GSTIN, state, address, pincode, PAN, credit period) and Zoho Books
-- (contact) need, so a later write-back can push a party without asking
-- the user again. external_refs holds the ids those systems give back.
--
-- Safe to re-run. Additive only: no existing column, row or policy changes
-- meaning.

alter table public.ledger_parties
  add column if not exists state         text,
  add column if not exists pincode       text,
  add column if not exists pan           text,
  add column if not exists credit_days   integer,
  add column if not exists source        text not null default 'manual',   -- manual | import | whatsapp | margyn
  add column if not exists external_refs jsonb not null default '{}'::jsonb, -- e.g. {"tally_guid":"...","zoho_contact_id":"..."}
  add column if not exists updated_at    timestamptz not null default now();

-- Lookups the app does before every create (GSTIN first, then name), so the
-- same party isn't added twice. Not a UNIQUE index: older rows may already
-- repeat a GSTIN and this migration must not fail on them. The app
-- de-duplicates (spellings vary too much for a hard name constraint:
-- "Acme Retail" vs "ACME RETAIL PVT LTD").
create index if not exists ledger_parties_user_gstin
  on public.ledger_parties (user_id, upper(gstin)) where gstin is not null and gstin <> '';
create index if not exists ledger_parties_user_name
  on public.ledger_parties (user_id, lower(name));

-- Link each open item to its party. Nullable: connector rows and older
-- entries keep matching by name, exactly as today.
alter table public.receivables add column if not exists party_id uuid references public.ledger_parties(id) on delete set null;
alter table public.payables    add column if not exists party_id uuid references public.ledger_parties(id) on delete set null;
create index if not exists receivables_party_id on public.receivables (party_id) where party_id is not null;
create index if not exists payables_party_id    on public.payables (party_id) where party_id is not null;

-- RLS: the table already has row-level security (the app has always
-- inserted and read its own rows). Editing a party from the Customers page
-- is new, so make sure an owner-only UPDATE policy exists.
alter table public.ledger_parties enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ledger_parties' and cmd in ('UPDATE', 'ALL')
  ) then
    create policy ledger_parties_update_own on public.ledger_parties
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ledger_parties' and cmd in ('INSERT', 'ALL')
  ) then
    create policy ledger_parties_insert_own on public.ledger_parties
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ledger_parties' and cmd in ('SELECT', 'ALL')
  ) then
    create policy ledger_parties_select_own on public.ledger_parties
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- Check: should list the new columns and at least one policy per command.
-- select column_name from information_schema.columns where table_name = 'ledger_parties' order by ordinal_position;
-- select policyname, cmd from pg_policies where tablename = 'ledger_parties';
