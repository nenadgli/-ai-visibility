-- Analitika za dashboard. Svi filteri su opcioni (null = sve).

-- Osnovni skup odgovora po filterima
create or replace function public._resp(p_ws uuid, p_run uuid, p_provider text, p_market text)
returns setof public.responses language sql stable as $$
  select * from public.responses r
   where r.workspace_id = p_ws
     and r.status = 'done'
     and (p_run is null or r.run_id = p_run)
     and (p_provider is null or r.provider = p_provider)
     and (p_market is null or r.market = p_market);
$$;

-- 1) Vidljivost brendova (share of voice) po sistemu
create or replace function public.get_visibility(p_ws uuid, p_run uuid default null, p_provider text default null, p_market text default null)
returns table (
  brand_id uuid, brand text, is_own boolean, color text, provider text,
  responses int, mentioned int, mention_rate numeric, avg_rank numeric, top1 int,
  positive int, negative int, recommended int, linked int
) language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, p_provider, p_market)),
  tot as (select provider, count(*)::int n from r group by provider)
  select b.id, b.name, b.is_own, b.color, t.provider, t.n,
         count(m.id)::int,
         round(100.0 * count(m.id) / nullif(t.n,0), 1),
         round(avg(m.rank)::numeric, 2),
         count(*) filter (where m.rank = 1)::int,
         count(*) filter (where m.sentiment = 'positive')::int,
         count(*) filter (where m.sentiment = 'negative')::int,
         count(*) filter (where m.recommended)::int,
         count(*) filter (where m.linked)::int
    from public.brands b
    cross join tot t
    left join r on r.provider = t.provider
    left join public.mentions m on m.response_id = r.id and m.brand_id = b.id
   where b.workspace_id = p_ws
   group by b.id, b.name, b.is_own, b.color, t.provider, t.n;
$$;

-- 2) Uticaj domena: šta AI čita, šta citira, i uz koje brendove
create or replace function public.get_domain_influence(p_ws uuid, p_run uuid default null, p_provider text default null, p_market text default null)
returns table (
  domain text, category text, retrieved_in int, cited_in int, citations int, cite_rate numeric,
  cited_with_own int, cited_with_competitor_no_own int, providers text[], sample_urls text[]
) language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, p_provider, p_market)),
  own as (
    select m.response_id, bool_or(b.is_own) has_own, bool_or(not b.is_own) has_comp
      from public.mentions m join public.brands b on b.id = m.brand_id
     where m.response_id in (select id from r)
     group by m.response_id
  )
  select s.domain,
         coalesce(dl.category, case
           when exists (select 1 from public.brands b where b.workspace_id = p_ws and b.is_own and s.domain = any(b.domains)) then 'own'
           when exists (select 1 from public.brands b where b.workspace_id = p_ws and not b.is_own and s.domain = any(b.domains)) then 'competitor'
           else null end),
         count(distinct s.response_id)::int,
         count(distinct s.response_id) filter (where s.cited)::int,
         sum(s.citation_count)::int,
         round(100.0 * count(distinct s.response_id) filter (where s.cited) / nullif(count(distinct s.response_id),0), 1),
         count(distinct s.response_id) filter (where s.cited and o.has_own)::int,
         count(distinct s.response_id) filter (where s.cited and o.has_comp and not coalesce(o.has_own,false))::int,
         array_agg(distinct r.provider),
         (array_agg(distinct s.url))[1:5]
    from r
    join public.sources s on s.response_id = r.id
    left join own o on o.response_id = r.id
    left join public.domain_labels dl on dl.domain = s.domain
   group by s.domain, dl.category
   order by 4 desc, 3 desc;
$$;

-- 3) Fan-out pretrage: šta AI zapravo traži na webu
create or replace function public.get_fanout(p_ws uuid, p_run uuid default null, p_provider text default null, p_market text default null)
returns table (query text, times int, providers text[], prompts int, avg_sources numeric)
language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, p_provider, p_market))
  select lower(trim(q.query)), count(*)::int, array_agg(distinct r.provider), count(distinct r.prompt_id)::int,
         round(avg((select count(*) from public.sources s where s.response_id = r.id and s.query_idx = q.idx))::numeric, 1)
    from r join public.search_queries q on q.response_id = r.id
   group by lower(trim(q.query))
   order by 2 desc;
$$;

-- 4) Matrica upit × sistem
create or replace function public.get_prompt_matrix(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (
  prompt_id uuid, prompt text, market text, topic text, provider text, samples int,
  own_mentioned int, own_best_rank int, competitors text[], avg_queries numeric, avg_cited numeric
) language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market))
  select p.id, p.text, p.market, p.topic, r.provider, count(distinct r.id)::int,
         count(distinct r.id) filter (where b.is_own)::int,
         min(m.rank) filter (where b.is_own),
         array_remove(array_agg(distinct case when not b.is_own then b.name end), null),
         round(avg((select count(*) from public.search_queries q where q.response_id = r.id))::numeric, 1),
         round(avg((select count(*) from public.sources s where s.response_id = r.id and s.cited))::numeric, 1)
    from r
    join public.prompts p on p.id = r.prompt_id
    left join public.mentions m on m.response_id = r.id
    left join public.brands b on b.id = m.brand_id
   group by p.id, p.text, p.market, p.topic, r.provider;
$$;

-- 5) Trend sopstvenog brenda kroz pokretanja
create or replace function public.get_trend(p_ws uuid, p_market text default null)
returns table (run_id uuid, run_at timestamptz, provider text, responses int, own_rate numeric, avg_own_rank numeric)
language sql stable as $$
  select r.run_id, ru.created_at, r.provider, count(distinct r.id)::int,
         round(100.0 * count(distinct r.id) filter (where b.is_own) / nullif(count(distinct r.id),0), 1),
         round(avg(m.rank) filter (where b.is_own)::numeric, 2)
    from public.responses r
    join public.runs ru on ru.id = r.run_id
    left join public.mentions m on m.response_id = r.id
    left join public.brands b on b.id = m.brand_id
   where r.workspace_id = p_ws and r.status = 'done' and (p_market is null or r.market = p_market)
   group by r.run_id, ru.created_at, r.provider
   order by ru.created_at;
$$;

-- 6) Zbirni pokazatelji procesa (koliko AI pretražuje, čita, citira)
create or replace function public.get_process_stats(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (provider text, responses int, used_search_pct numeric, avg_queries numeric, avg_retrieved numeric, avg_cited numeric, avg_answer_len numeric, avg_latency_ms numeric)
language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market))
  select r.provider, count(*)::int,
         round(100.0 * count(*) filter (where r.used_search) / nullif(count(*),0), 1),
         round(avg((select count(*) from public.search_queries q where q.response_id = r.id))::numeric, 1),
         round(avg((select count(*) from public.sources s where s.response_id = r.id))::numeric, 1),
         round(avg((select count(*) from public.sources s where s.response_id = r.id and s.cited))::numeric, 1),
         round(avg(length(r.answer))::numeric, 0),
         round(avg(r.latency_ms)::numeric, 0)
    from r group by r.provider;
$$;
