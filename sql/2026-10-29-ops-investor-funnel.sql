-- Margyn — Ops: privacy-respecting event layer + investor tenants funnel
-- 2026-10-29
--
-- Additive only. Safe to re-run. NOT APPLIED — run in the Supabase SQL Editor
-- before deploying the matching api/ops.js / api/_lib/eventSchema.js / ops.html.
--
-- 1. product_events: five new server-side Zoho event names. Their properties
--    are enumerated in api/_lib/eventSchema.js (counts, flags, closed error
--    codes — never amounts, party names, GSTINs, free text, emails, phones).
--    Without this CHECK update the inserts are rejected and the funnel stays empty.
-- 2. ops_investor_tenants: which preview link (?ref=) belongs to which Margyn
--    login. Founder-only (RLS on, zero policies, service role via api/ops.js).
--    The funnel itself is derived at read time from product_events,
--    preview_views and connector_logs; nothing else is copied here.
-- 3. A small belt-and-braces CHECK: product_events.props may not carry the
--    obviously-unsafe keys even if a future code path bypasses track.js.

-- ============================================================================
-- 1. event-name allowlist (supersedes 2026-10-03-margyn-watch.sql's list)
-- ============================================================================
alter table public.product_events drop constraint if exists product_events_name_allowlist;
alter table public.product_events add constraint product_events_name_allowlist check (name in (
  'app_open',
  'connector_sync_manual',
  'reconcile_run',
  'reconcile_summary_view',
  'mismatch_opened',
  'mismatch_resolved_marked',
  'ask_message_sent',
  'whatsapp_inbound',
  'whatsapp_outbound',
  'tally_agent_sync',
  'briefing_opened',
  'question_asked',
  'watch_sent',
  'zoho_connect_started',
  'zoho_callback',
  'zoho_org_selected',
  'zoho_sync',
  'zoho_gstr2b_sync'
));

-- ============================================================================
-- 3. props may not carry unsafe keys (defence in depth for eventSchema.js)
-- ============================================================================
-- NOT VALID: existing rows are not re-checked (older props were already
-- stripped by track.js's blocklist); every new insert is.
alter table public.product_events drop constraint if exists product_events_props_safe_keys;
alter table public.product_events add constraint product_events_props_safe_keys check (
  not (props ?| array['amount', 'name', 'gstin', 'text', 'email', 'phone', 'body', 'message',
                      'vendor_name', 'customer_name', 'organization_name', 'org_name',
                      'vendor_gstin', 'from_phone', 'raw_payload', 'payload'])
) not valid;

-- ============================================================================
-- 2. ops_investor_tenants
-- ============================================================================
create table if not exists public.ops_investor_tenants (
  ref         text primary key check (ref ~ '^[a-z0-9_-]{1,60}$'),  -- same shape as preview_views.ref
  user_id     uuid unique references auth.users(id) on delete set null, -- null until they have a login
  invited_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text                                                   -- founder label, like ops_partner_notes
);

alter table public.ops_investor_tenants enable row level security;
-- NO policies: founder-only, read and written by api/ops.js with the service role.

comment on table public.ops_investor_tenants is
  'Founder ops: preview ref -> Margyn login for investor tenants. Funnel derived at read time in api/_lib/investorFunnel.js. No PII beyond the founder-chosen ref slug.';
