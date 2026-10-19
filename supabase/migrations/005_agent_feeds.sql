-- Agent Feed: ispravljeni feedovi koje generišemo iz klijentovog feeda (tools/agent-feed/build.mjs)
create table public.agent_feeds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,                              -- npr. 'Srbija – Google'
  source_url text not null,                        -- klijentov feed (ulaz)
  site_url text,
  -- nasumičan deo putanje u javnom bucketu, da se link ne može pogoditi
  token text not null unique default encode(gen_random_bytes(9), 'hex'),
  config jsonb not null default '{}',              -- npr. {"size_crawl_per_run": 800}
  active boolean not null default true,
  last_items int,                                  -- broj proizvoda u poslednjem objavljenom feedu (za zaštitu od pada)
  last_built_at timestamptz,
  last_checked_at timestamptz,
  last_error text,                                 -- poslednji razlog zašto feed NIJE objavljen
  stats jsonb,
  created_at timestamptz not null default now()
);
create index on public.agent_feeds(workspace_id);

alter table public.agent_feeds enable row level security;
create policy "auth_all" on public.agent_feeds for all to authenticated using (true) with check (true);

-- feeds: javni (Google i Meta ih preuzimaju), upis samo service role; feed-cache: privatni keš veličina
insert into storage.buckets (id, name, public) values ('feeds', 'feeds', true), ('feed-cache', 'feed-cache', false)
on conflict (id) do nothing;
