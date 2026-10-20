-- Ukrštanje je ostalo prazno: get_own_pages, get_catalog_fanout i get_catalog_prompt_fit su prelazili vremensko
-- ograničenje upita (8 s za prijavljene korisnike), a stranica je tada prazna. Uzrok: katalog se pretraživao
-- iznova za svaki izvor, pretragu i upit (_catalog_brand: ~800 × 15.000 proizvoda).
-- Sada se brendovi i putanje proizvoda iz kataloga računaju jednom po pozivu. Rezultati su isti; svaka funkcija < 0,5 s.

create index if not exists catalog_products_ws_nbrand on public.catalog_products(workspace_id, nbrand, brand);

create or replace function public.get_own_pages(p_ws uuid, p_run uuid DEFAULT NULL::uuid, p_market text DEFAULT NULL::text)
 RETURNS TABLE(host text, page_type text, reads integer, cited integer, urls integer, in_catalog integer, examples text[])
 LANGUAGE sql STABLE
AS $function$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  dom as (select unnest(domains) d from public.brands where workspace_id = p_ws and is_own),
  -- putanje proizvoda iz kataloga, jednom (spajanje po putanji umesto regex poređenja za svaki izvor)
  cat as materialized (select distinct regexp_replace(link, '^https?://[^/]+', '') p from public.catalog_products where workspace_id = p_ws and link is not null),
  s as (
    select s.url, s.cited, lower(substring(s.url from '^https?://([^/]+)')) host
      from public.sources s
     where s.response_id in (select id from r)
       and exists (select 1 from dom where s.domain = dom.d or s.domain like '%.' || dom.d)
  ),
  t as (
    select s.*,
           case
             when url ~* '\.pdf($|\?)' then 'pdf'
             when url ~* '/filter/' or url ~* '[?&](p|page|dir|order|limit)=' then 'filter'
             when url ~* '/(o-nama|prodajna-mesta|kontakt|dostava|isporuka|povrat|reklamacij|faq|uslovi|pomoc|placanje)' then 'info'
             when url ~* '^https?://[^/]+/?([a-z]{2}/?)?$' then 'home'
             when url ~* '^https?://[^/]+/[a-z]{2}/[^/]+-[a-z0-9]*[0-9][a-z0-9]*/?$' then 'product'
             else 'category'
           end page_type,
           cat.p is not null in_cat
      from s left join cat on cat.p = regexp_replace(s.url, '^https?://[^/]+', '')
  )
  select host, page_type, count(*)::int, count(*) filter (where cited)::int, count(distinct url)::int,
         count(distinct url) filter (where in_cat)::int, (array_agg(distinct url))[1:5]
    from t group by host, page_type order by count(*) desc;
$function$;

create or replace function public.get_catalog_fanout(p_ws uuid, p_run uuid DEFAULT NULL::uuid, p_market text DEFAULT NULL::text)
 RETURNS TABLE(query text, times integer, prompts integer, brand text, terms text[], model_in_orig integer, model_in_ours integer, model_anywhere integer, brand_items integer)
 LANGUAGE sql STABLE
AS $function$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  q as (
    select public._norm(sq.query) nq, min(sq.query) query, count(*)::int times, count(distinct r.prompt_id)::int prompts
      from public.search_queries sq join r on r.id = sq.response_id
     group by 1
  ),
  comp as (select public._norm(n) n from public.brands b, unnest(array[b.name] || b.aliases || b.domains) n where b.workspace_id = p_ws and not b.is_own),
  -- brendovi iz kataloga jednom (ranije _catalog_brand za svaku pretragu: ~800 × ceo katalog)
  cb as materialized (select brand, nbrand, count(*)::int items from public.catalog_products where workspace_id = p_ws and nbrand <> '' group by brand, nbrand),
  b as (select q.*, (select cb.brand from cb where position(' ' || cb.nbrand || ' ' in ' ' || q.nq || ' ') > 0 order by length(cb.nbrand) desc limit 1) brand
          from q
         where not exists (select 1 from comp where comp.n <> '' and position(' ' || comp.n || ' ' in ' ' || q.nq || ' ') > 0)),
  t as (select b.*, public._model_terms(b.query, b.brand) terms from b where b.brand is not null)
  select t.query, t.times, t.prompts, t.brand, t.terms, m.in_orig, m.in_ours, m.anywhere,
         (select sum(cb.items)::int from cb where cb.brand = t.brand)
    from t left join lateral public._model_hits(p_ws, t.brand, t.terms) m on cardinality(t.terms) > 0
   order by t.times desc, t.query;
$function$;

create or replace function public.get_catalog_prompt_fit(p_ws uuid, p_run uuid DEFAULT NULL::uuid, p_market text DEFAULT NULL::text)
 RETURNS TABLE(prompt_id uuid, prompt text, market text, intent text, answers integer, own_mentioned integer, own_rate numeric, competitors text[], brand text, brand_items integer, brand_on_sale integer, brand_min_price numeric, model_terms text[], model_in_orig integer, model_in_ours integer, model_anywhere integer, model_min_price numeric, sample_link text, verdict text)
 LANGUAGE sql STABLE
AS $function$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  own as (select id from public.brands where workspace_id = p_ws and is_own),
  -- brendovi iz kataloga jednom (ranije _catalog_brand za svaki upit: ceo katalog po upitu)
  cb as materialized (select brand, nbrand, count(*)::int items, count(*) filter (where sale_price is not null)::int on_sale, min(coalesce(sale_price, price)) min_price
                        from public.catalog_products where workspace_id = p_ws and nbrand <> '' group by brand, nbrand),
  pr as (
    select p.id, p.text, p.market, p.intent,
           count(distinct r.id)::int answers,
           count(distinct r.id) filter (where exists (select 1 from public.mentions m where m.response_id = r.id and m.brand_id in (select id from own)))::int own_n,
           (select array_agg(distinct b.name order by b.name) from public.mentions m join public.brands b on b.id = m.brand_id
             where m.response_id in (select id from r r2 where r2.prompt_id = p.id) and not b.is_own) comps
      from public.prompts p join r on r.prompt_id = p.id
     where p.workspace_id = p_ws
     group by p.id
  ),
  pb as (
    select pr.*, (select cb.brand from cb where position(' ' || cb.nbrand || ' ' in ' ' || public._norm(pr.text) || ' ') > 0 order by length(cb.nbrand) desc limit 1) brand
      from pr
  ),
  x as (
    select pb.*, public._model_terms(pb.text, pb.brand) terms from pb
  )
  select x.id, x.text, x.market, x.intent, x.answers, x.own_n, round(100.0 * x.own_n / nullif(x.answers, 0), 0), coalesce(x.comps, '{}'),
         x.brand, b.items, b.on_sale, b.min_price,
         case when x.brand is null then '{}' else x.terms end,
         m.in_orig, m.in_ours, m.anywhere, m.min_price, m.link,
         case
           when x.brand is null and x.intent = 'brand' then 'brand_query'
           when x.brand is null and x.text ~* '\m(nike|adidas|puma|converse|vans|reebok|asics|fila|jordan|salomon|hoka)\M' and x.own_n > 0 then 'false_claim'
           when x.brand is null and x.text ~* '\m(nike|adidas|puma|converse|vans|reebok|asics|fila|jordan|salomon|hoka)\M' then 'not_carried'
           when x.brand is null then 'general'
           when cardinality(x.terms) > 0 and coalesce(m.anywhere, 0) = 0 then 'model_missing'
           when cardinality(x.terms) > 0 and m.in_orig = 0 and m.in_ours > 0 then 'model_fixed'
           when cardinality(x.terms) > 0 and m.in_orig = 0 then 'model_hidden'
           when 100.0 * x.own_n / nullif(x.answers, 0) < 60 then 'gap'
           else 'ok'
         end
    from x
    left join lateral (
      select sum(cb.items)::int items, sum(cb.on_sale)::int on_sale, min(cb.min_price) min_price from cb where cb.brand = x.brand
    ) b on x.brand is not null
    left join lateral public._model_hits(p_ws, x.brand, x.terms) m on x.brand is not null and cardinality(x.terms) > 0;
$function$;
