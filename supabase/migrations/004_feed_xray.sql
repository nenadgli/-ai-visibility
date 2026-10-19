-- Feed X-ray: product feed klijenta, snimci kvaliteta i strukture asortimana kroz vreme
create table public.feeds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,                        -- npr. 'Srbija – Google Merchant'
  url text not null,
  site_url text,                             -- za proveru proizvodnih stranica i pristupa botova
  market text not null default 'RS' check (market in ('RS','HR','BA','EN')),
  created_at timestamptz not null default now()
);
create index on public.feeds(workspace_id);

-- Jedan snimak = jedno skeniranje (tools/feed-xray/scan.mjs). Agregati su u data (jsonb),
-- jer se struktura izveštaja menja brže od šeme; skor i broj artikala su kolone zbog trenda.
create table public.feed_snapshots (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds(id) on delete cascade,
  scanned_at timestamptz not null default now(),
  score int not null check (score between 0 and 100),
  items int not null,
  data jsonb not null
);
create index on public.feed_snapshots(feed_id, scanned_at desc);

alter table public.feeds enable row level security;
alter table public.feed_snapshots enable row level security;
create policy "auth_all" on public.feeds for all to authenticated using (true) with check (true);
create policy "auth_all" on public.feed_snapshots for all to authenticated using (true) with check (true);
