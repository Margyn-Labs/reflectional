-- Tally structure: let Tally say what each ledger and voucher type IS (2026-10-02).
-- Run in the Supabase SQL editor. Safe to re-run. Until the agent that sends these is installed,
-- the columns stay empty and Margyn falls back to guessing from names, as before.
--
-- primary_group: the reserved group at the top of the ledger's chain (Sundry Debtors, Sales Accounts, ...).
-- voucher_base:  the base type a renamed voucher type rolls up to (Sales, Purchase, Receipt, ...).

alter table public.tally_ledgers  add column if not exists primary_group text;
alter table public.tally_vouchers add column if not exists voucher_base  text;
