-- 2026-10-16: view log for margynlabs.com/preview (investor film page).
-- One row per milestone (open / play / half / end) per visit, keyed by the
-- ?ref= tag in each investor's link. Written only by the server
-- (service role); no browser can read or write it.

create table if not exists public.preview_views (
  id          bigserial primary key,
  ref         text not null,
  event       text not null check (event in ('open','play','half','end')),
  city        text,
  country     text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists preview_views_ref_idx on public.preview_views (ref, created_at desc);

alter table public.preview_views enable row level security;
-- no policies: only the service role (server) can touch it.

-- Handy summary: who opened, who played, who watched to the end.
create or replace view public.preview_views_summary as
select ref,
       min(created_at) filter (where event = 'open') as first_opened,
       count(*)        filter (where event = 'open') as opens,
       bool_or(event = 'play') as played,
       bool_or(event = 'half') as watched_half,
       bool_or(event = 'end')  as watched_to_end,
       max(created_at) as last_seen
from public.preview_views
group by ref
order by last_seen desc;

revoke all on public.preview_views_summary from anon, authenticated;
