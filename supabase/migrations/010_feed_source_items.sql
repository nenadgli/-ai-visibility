-- Originalni feed klijenta, takav kakav jeste: svaki <item> iz ulaznog feeda doslovno (raw), uz nekoliko polja za pretragu.
-- Puni ga Agent Feed (build.mjs); upisuju se samo proizvodi čiji se XML promenio (hash), nestali se brišu.
-- Zaglavlje feeda, veličina i popunjenost polja su u agent_feeds.stats.source.

create table public.feed_source_items (
  feed_id uuid not null references public.agent_feeds(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id text not null,
  pos int not null,                    -- redosled u feedu
  title text,
  brand text,
  size text,
  product_type text,
  price text,
  sale_price text,
  availability text,
  raw text not null,                   -- <item>…</item> tačno kako je u feedu
  hash text not null,
  updated_at timestamptz not null default now(),
  primary key (feed_id, product_id)
);
alter table public.feed_source_items
  add column nsearch text generated always as (public._norm(product_id || ' ' || coalesce(brand, '') || ' ' || coalesce(title, ''))) stored;
create index on public.feed_source_items(workspace_id, pos);
alter table public.feed_source_items enable row level security;
create policy "auth_all" on public.feed_source_items for all to authenticated using (true) with check (true);
