-- Books layer (api/_lib/dataLayer/books.js), 2026-10-04.
-- Sales before GST for Zoho Books and Odoo, so their P&L isn't overstated by tax.
-- Safe to run more than once. Syncs work without it (the new fields are skipped).
alter table zoho_invoices add column if not exists sub_total numeric;
alter table zoho_bills    add column if not exists sub_total numeric;
alter table odoo_invoices add column if not exists amount_untaxed numeric;
alter table odoo_bills    add column if not exists amount_untaxed numeric;
