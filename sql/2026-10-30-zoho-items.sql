-- Zoho Books item lines (2026-10-30, ZOHO-ITEM-LEVEL-PLAN.md §4.1).
-- Run in the Supabase SQL editor BEFORE deploying the item-level sync. Safe to re-run.
--
-- Zoho's list endpoints never return line items, so api/_zoho/sync.js reads each invoice, bill, credit note and
-- vendor credit once (GET /invoices/{id} ...), newest first, inside the plan's daily call budget, and keeps:
--   zoho_items           the item master (GET /items): names, units, selling and purchase rates
--   zoho_document_lines  one row per item line, with its value before tax in the base currency (`value`)
--   zoho_line_state      every document and whether its lines have been read since it last changed
-- The books layer (api/_lib/dataLayer/books.js) puts the lines on the Sales, Purchase, Credit Note and Debit
-- Note vouchers in Tally's `items` shape. Same RLS as the other zoho_* tables: the owner can read their own
-- org's rows; only the service role (the sync) writes.

create table if not exists public.zoho_items (
  id                  bigserial primary key,
  org_ref             uuid not null references public.zoho_organizations(id) on delete cascade,
  item_id             text not null,
  name                text,
  sku                 text,
  unit                text,
  rate                numeric,          -- selling rate
  purchase_rate       numeric,          -- fallback unit cost when an item has no purchase lines (basis 'item master')
  product_type        text,             -- goods | service | digital_service
  item_type           text,             -- sales | purchases | sales_and_purchases | inventory
  status              text,
  stock_on_hand       numeric,
  last_modified_time  timestamptz,
  synced_at           timestamptz not null default now(),
  unique (org_ref, item_id)
);

create table if not exists public.zoho_document_lines (
  id                  bigserial primary key,
  org_ref             uuid not null references public.zoho_organizations(id) on delete cascade,
  doc_type            text not null check (doc_type in ('invoice', 'bill', 'creditnote', 'vendorcredit')),
  doc_id              text not null,
  line_item_id        text not null,
  item_id             text,
  item_name           text,
  sku                 text,
  qty                 numeric,          -- always positive; the sign comes from the voucher type
  unit                text,
  rate                numeric,          -- Zoho's rate, document currency
  bcy_rate            numeric,          -- Zoho's rate, base currency
  discount_amount     numeric,          -- line discount
  item_total          numeric,          -- Zoho's line total, document currency
  tax_pct             numeric,
  is_inclusive_tax    boolean,
  value               numeric,          -- before tax, base currency, after any document discount before tax (positive)
  location_name       text,             -- -> godown
  account_id          text,
  doc_date            date,
  synced_at           timestamptz not null default now(),
  unique (org_ref, doc_type, line_item_id)
);

create table if not exists public.zoho_line_state (
  id                  bigserial primary key,
  org_ref             uuid not null references public.zoho_organizations(id) on delete cascade,
  doc_type            text not null check (doc_type in ('invoice', 'bill', 'creditnote', 'vendorcredit')),
  doc_id              text not null,
  doc_number          text,
  doc_date            date,
  status              text,
  doc_last_modified   timestamptz,      -- Zoho's last_modified_time from the list
  read_modified       timestamptz,      -- the last_modified_time the lines were read at (re-read when it moves)
  lines_read_at       timestamptz,      -- null = lines still to read
  line_count          integer,
  unique (org_ref, doc_type, doc_id)
);

create index if not exists zoho_document_lines_doc on public.zoho_document_lines (org_ref, doc_type, doc_id);
create index if not exists zoho_line_state_queue on public.zoho_line_state (org_ref, lines_read_at);

alter table public.zoho_items enable row level security;
alter table public.zoho_document_lines enable row level security;
alter table public.zoho_line_state enable row level security;

drop policy if exists zoho_items_select_own on public.zoho_items;
create policy zoho_items_select_own on public.zoho_items for select
  using (exists (select 1 from public.zoho_organizations o where o.id = org_ref and o.user_id = auth.uid()));
drop policy if exists zoho_document_lines_select_own on public.zoho_document_lines;
create policy zoho_document_lines_select_own on public.zoho_document_lines for select
  using (exists (select 1 from public.zoho_organizations o where o.id = org_ref and o.user_id = auth.uid()));
drop policy if exists zoho_line_state_select_own on public.zoho_line_state;
create policy zoho_line_state_select_own on public.zoho_line_state for select
  using (exists (select 1 from public.zoho_organizations o where o.id = org_ref and o.user_id = auth.uid()));
-- no insert/update/delete policy: service role only
