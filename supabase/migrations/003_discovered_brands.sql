alter table public.responses add column discovered_brands text[] not null default '{}';
alter table public.responses add column analyzed_at timestamptz;

-- Brendovi koje AI pominje a koje ne pratimo
create or replace function public.get_discovered_brands(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (brand text, times int, providers text[], prompts int)
language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market))
  select d, count(*)::int, array_agg(distinct r.provider), count(distinct r.prompt_id)::int
    from r, unnest(r.discovered_brands) d
   group by d order by 2 desc;
$$;
