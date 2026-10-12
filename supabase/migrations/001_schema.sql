-- AI Visibility: praćenje pominjanja brendova u AI odgovorima + trag kako AI dolazi do odgovora
create extension if not exists pgcrypto;

-- Klijent / radni prostor (npr. Fashion & Friends)
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_markets text[] not null default '{RS}',
  created_at timestamptz not null default now()
);

-- Brendovi: sopstveni + konkurenti
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',      -- alternativni nazivi, npr. 'F&F', 'Fashion and Friends'
  domains text[] not null default '{}',      -- npr. 'fashionandfriends.com'
  is_own boolean not null default false,
  color text,
  created_at timestamptz not null default now()
);
create index on public.brands(workspace_id);

-- Upiti koji se postavljaju AI sistemima
create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  text text not null,
  market text not null default 'RS' check (market in ('RS','HR','BA','EN')),
  topic text,                                -- npr. 'patike', 'jakne', 'online kupovina'
  intent text check (intent in ('discovery','comparison','brand','transactional','informational')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.prompts(workspace_id);

-- Jedno pokretanje = svi aktivni upiti × odabrani sistemi × broj ponavljanja
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  providers text[] not null,
  samples int not null default 1 check (samples between 1 and 5),
  status text not null default 'running' check (status in ('running','done','error')),
  note text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on public.runs(workspace_id, created_at desc);

-- Jedan odgovor jednog AI sistema na jedan upit
create table public.responses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  provider text not null check (provider in ('chatgpt','claude','gemini','perplexity','google_aio')),
  market text not null,
  sample int not null default 1,
  status text not null default 'pending' check (status in ('pending','processing','done','error','empty')),
  attempts int not null default 0,
  model text,
  answer text,
  used_search boolean,                       -- da li je model uopšte išao na web
  search_count int,
  latency_ms int,
  usage jsonb,
  raw jsonb,
  error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index on public.responses(run_id, status);
create index on public.responses(workspace_id, provider);
create index on public.responses(status, locked_at);

-- Fan-out: pretrage koje je model sam generisao
create table public.search_queries (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.responses(id) on delete cascade,
  idx int not null,
  query text not null
);
create index on public.search_queries(response_id);

-- Izvori: šta je model pročitao (retrieved) i šta je citirao (cited)
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.responses(id) on delete cascade,
  url text not null,
  domain text not null,
  title text,
  snippet text,
  query_idx int,                             -- iz koje fan-out pretrage je došao (ako se zna)
  retrieved_rank int,                        -- redosled u rezultatima pretrage
  cited boolean not null default false,
  citation_count int not null default 0,
  first_cited_pos int,                       -- pozicija prvog citata u tekstu odgovora
  unique (response_id, url)
);
create index on public.sources(response_id);
create index on public.sources(domain);

-- Koji deo odgovora se oslanja na koji izvor
create table public.citations (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.responses(id) on delete cascade,
  source_id uuid references public.sources(id) on delete cascade,
  start_index int,
  end_index int,
  answer_text text,                          -- deo odgovora koji je potkrepljen
  cited_text text                            -- deo izvora koji je citiran (Claude daje)
);
create index on public.citations(response_id);
create index on public.citations(source_id);

-- Pominjanja brendova u odgovoru
create table public.mentions (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.responses(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  mention_count int not null default 0,
  first_pos int,                             -- karakter gde se prvi put pominje
  rank int,                                  -- 1 = prvi pomenuti brend u odgovoru
  linked boolean not null default false,     -- da li je citiran domen brenda
  sentiment text check (sentiment in ('positive','neutral','negative','mixed')),
  recommended boolean,
  context text,                              -- rečenica u kojoj se pominje
  reasons text[],                            -- zašto ga AI pominje (atributi)
  unique (response_id, brand_id)
);
create index on public.mentions(brand_id);

-- Kategorije domena (ručno + automatski)
create table public.domain_labels (
  domain text primary key,
  category text not null check (category in ('own','competitor','marketplace','media','forum','review','social','wiki','brand_official','directory','other')),
  note text
);

-- ---------------------------------------------------------------------------
-- Queue: preuzimanje sledećih poslova bez dupliranja
create or replace function public.claim_responses(batch int default 6)
returns setof public.responses
language sql
security definer
set search_path = public
as $$
  update public.responses r
     set status = 'processing', locked_at = now(), attempts = attempts + 1
   where r.id in (
     select id from public.responses
      where status = 'pending'
         or (status = 'processing' and locked_at < now() - interval '5 minutes' and attempts < 3)
      order by created_at
      limit batch
      for update skip locked)
  returning r.*;
$$;

create or replace function public.finish_run_if_done(p_run uuid)
returns void language sql security definer set search_path = public as $$
  update public.runs set status = 'done', finished_at = now()
   where id = p_run and status = 'running'
     and not exists (select 1 from public.responses where run_id = p_run and status in ('pending','processing'));
$$;

-- ---------------------------------------------------------------------------
-- RLS: interni alat — svaki ulogovani korisnik agencije vidi sve
do $$
declare t text;
begin
  foreach t in array array['workspaces','brands','prompts','runs','responses','search_queries','sources','citations','mentions','domain_labels']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "auth_all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

revoke execute on function public.claim_responses(int) from anon, authenticated, public;
revoke execute on function public.finish_run_if_done(uuid) from anon, authenticated, public;
