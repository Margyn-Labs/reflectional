-- Zoho Books postings carry the customer or vendor they belong to (customer_id / vendor_id on
-- GET chartofaccounts/transactions). Stored so a credit note or a bill lands against its party in the
-- books layer, the same way a Tally voucher does. sync.js keeps working without this column.
alter table public.zoho_journal_entries add column if not exists party_ref text;

-- Receipt and payment numbers as Zoho shows them, so a receipt reads "160", as a Tally receipt shows its number.
alter table public.zoho_customer_payments add column if not exists payment_number text;
alter table public.zoho_vendor_payments add column if not exists payment_number text;

-- Zoho's own document number on each posting (a journal's or an expense's number), shown on its voucher.
alter table public.zoho_journal_entries add column if not exists entry_number text;

-- Zoho's own count of invoices and bills, from the weekly full listing (rows module = 'count:<module>'),
-- for the "Is all your data in?" check.
alter table public.zoho_sync_state add column if not exists remote_count integer;
