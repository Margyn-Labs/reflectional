-- Zoho Books ↔ Tally parity (2026-11-01). Safe to run more than once. Changes nothing on a Tally account:
-- every column below is on a Zoho table, and nothing is deleted by this script.

-- Which invoice (bill) each payment cleared. The list gives the numbers (applied_numbers); one detail read per new
-- or changed payment gives each document with the amount applied and the tax the customer withheld (TDS).
-- links_read_at = when that detail was last read. sync.js keeps working without these columns.
alter table public.zoho_customer_payments add column if not exists applied_numbers text;
alter table public.zoho_customer_payments add column if not exists applied_to jsonb;
alter table public.zoho_customer_payments add column if not exists tax_withheld numeric(14,2);
alter table public.zoho_customer_payments add column if not exists links_read_at timestamptz;

alter table public.zoho_vendor_payments add column if not exists applied_numbers text;
alter table public.zoho_vendor_payments add column if not exists applied_to jsonb;
alter table public.zoho_vendor_payments add column if not exists tax_withheld numeric(14,2);
alter table public.zoho_vendor_payments add column if not exists links_read_at timestamptz;

-- When Margyn removed the copy of a replaced (or disconnected-with-remove) connection, so the nightly tidy-up
-- doesn't look at it again (api/_lib/selfCleanup.js).
alter table public.zoho_organizations add column if not exists data_removed_at timestamptz;

-- So the API sees the new columns straight away.
notify pgrst, 'reload schema';
