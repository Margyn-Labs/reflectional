-- 2026-10-08 · Tally party contacts (phone, email, GSTIN) for Payment Chase
-- ---------------------------------------------------------------------------
-- Tally agent 0.2.5+ reads each ledger's contact details (mobile, phone, email,
-- contact person, GSTIN, state, pincode, PAN, address). They are kept on the
-- ledger row here, and customers/suppliers with a phone or email also land in
-- ledger_parties (source = 'tally'), where Payment Chase looks up numbers.
--
-- Safe to re-run. Additive only. The server works before this runs too: it
-- stores ledgers without the column and still fills ledger_parties.

alter table public.tally_ledgers add column if not exists contact jsonb;

-- Check:
-- select name, contact from public.tally_ledgers where contact is not null limit 20;
-- select name, phone, email, gstin, source from public.ledger_parties where source = 'tally' order by name limit 50;
