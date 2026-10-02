-- 2026-10-02. Fixes AI ledger placements where a director's own remuneration
-- ledger ("X (REM)") was saved as creditor instead of opex, which kept that pay
-- out of costs and overstated profit. Only touches rows the AI set (set_by is
-- null); anything a person confirmed is left alone. Safe to re-run.
update public.tally_ledger_classes
set bucket = 'opex', updated_at = now()
where set_by is null
  and bucket = 'creditor'
  and ledger_name ~* '\((rem|remi|remuneration)\)'
returning ledger_name, bucket;
