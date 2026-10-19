-- Ukrštanje: katalog klijenta (iz feeda) × AI odgovori (upiti, fan-out pretrage, izvori).
-- Katalog puni Agent Feed (tools/agent-feed/build.mjs) pri svakom objavljivanju.

create table public.catalog_products (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id text not null,
  title text not null,                 -- naziv u našem Agent Feedu (ispravljen, sa modelom)
  orig_title text,                     -- naziv u klijentovom feedu
  description text,
  brand text,
  product_type text,
  link text,
  price numeric,
  sale_price numeric,
  sizes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (workspace_id, product_id)
);
create index on public.catalog_products(workspace_id, brand);
alter table public.catalog_products enable row level security;
create policy "auth_all" on public.catalog_products for all to authenticated using (true) with check (true);

-- Normalizacija za poređenje: mala slova, bez dijakritika i apostrofa, samo [a-z0-9&] i razmaci; "Lyle & Scott" = "Lyle&Scott"
create or replace function public._norm(t text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(translate(lower(coalesce(t, '')), 'čćžšđ''’', 'cczsd'), '\s*&\s*', '&', 'g'), '[^a-z0-9&]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

alter table public.catalog_products add column ntitle text generated always as (public._norm(title)) stored;
alter table public.catalog_products add column nbrand text generated always as (public._norm(brand)) stored;
alter table public.catalog_products add column norig text generated always as (public._norm(orig_title)) stored;
alter table public.catalog_products add column ndesc text generated always as (public._norm(description)) stored;

-- Nazivi modela iz teksta upita/pretrage: reči sa ciframa (9060, 501, 1DR, 6-Inch) i reči velikim slovom
-- usred rečenice (Samba, Everest, Possession), bez reči brenda, mesta i uobičajenih reči.
create or replace function public._model_terms(p_text text, p_brand text) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct public._norm(w)), '{}')
    from regexp_split_to_table(regexp_replace(coalesce(p_text, ''), '[?!:;()"|]|[.,](?![0-9])', ' ', 'g'), '\s+') with ordinality as t(w, i)
   where w <> ''
     and ((w ~ '[0-9]' and length(w) >= 2) or (w ~ '^''?[A-ZČĆŽŠĐ]' and i > 1))
     and w !~ '^[0-9]{1,3}([.,][0-9]{3})+'                     -- cene: 22.499, 49.990
     and public._norm(w) not in ('gde','gdje','da','srbija','srbiji','serbia','beograd','beogradu','hrvatska','hrvatskoj','croatia','bih','bosni','bosnia',
                                 'zagreb','zagrebu','novi','sad','nis','online','shop','store','official','site','rsd','eur','km','fashion','friends',
                                 'fashion&friends','f&f','cena','cijena','najniza','najniža','dodaj','korpu','zenske','muske','about','you')
     and position(' ' || public._norm(w) || ' ' in ' ' || public._norm(p_brand) || ' ') = 0
     and public._norm(w) <> '';
$$;

-- Brend iz kataloga koji se pominje u tekstu (najduži pogodak: "Guess Jeans" pre "Guess")
create or replace function public._catalog_brand(p_ws uuid, p_text text) returns text language sql stable as $$
  select b.brand from (select distinct brand, nbrand from public.catalog_products where workspace_id = p_ws and nbrand <> '') b
   where position(' ' || b.nbrand || ' ' in ' ' || public._norm(p_text) || ' ') > 0
   order by length(b.nbrand) desc limit 1;
$$;

-- Koliko proizvoda brenda sadrži sve nazive modela: u klijentovom nazivu, u našem nazivu, bilo gde (i opis)
create or replace function public._model_hits(p_ws uuid, p_brand text, p_terms text[])
returns table (in_orig int, in_ours int, anywhere int, min_price numeric, link text) language sql stable as $$
  select count(*) filter (where not exists (select 1 from unnest(p_terms) t where position(t in coalesce(c.norig, c.ntitle)) = 0))::int,
         count(*) filter (where not exists (select 1 from unnest(p_terms) t where position(t in c.ntitle) = 0))::int,
         count(*)::int,
         min(coalesce(c.sale_price, c.price)),
         min(c.link)
    from public.catalog_products c
   where c.workspace_id = p_ws and c.brand = p_brand and cardinality(p_terms) > 0
     and not exists (select 1 from unnest(p_terms) t where position(t in c.ntitle || ' ' || coalesce(c.norig, '') || ' ' || coalesce(c.ndesc, '')) = 0);
$$;

-- 1) Upit × katalog: da li AI pominje klijenta tamo gde ima robu (i obrnuto)
create or replace function public.get_catalog_prompt_fit(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (
  prompt_id uuid, prompt text, market text, intent text, answers int, own_mentioned int, own_rate numeric,
  competitors text[], brand text, brand_items int, brand_on_sale int, brand_min_price numeric,
  model_terms text[], model_in_orig int, model_in_ours int, model_anywhere int, model_min_price numeric, sample_link text, verdict text
) language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  own as (select id from public.brands where workspace_id = p_ws and is_own),
  pr as (
    select p.id, p.text, p.market, p.intent,
           count(distinct r.id)::int answers,
           count(distinct r.id) filter (where exists (select 1 from public.mentions m where m.response_id = r.id and m.brand_id in (select id from own)))::int own_n,
           (select array_agg(distinct b.name order by b.name) from public.mentions m join public.brands b on b.id = m.brand_id
             where m.response_id in (select id from r r2 where r2.prompt_id = p.id) and not b.is_own) comps,
           public._catalog_brand(p_ws, p.text) brand
      from public.prompts p join r on r.prompt_id = p.id
     where p.workspace_id = p_ws
     group by p.id
  ),
  x as (
    select pr.*, public._model_terms(pr.text, pr.brand) terms from pr
  )
  select x.id, x.text, x.market, x.intent, x.answers, x.own_n, round(100.0 * x.own_n / nullif(x.answers, 0), 0), coalesce(x.comps, '{}'),
         x.brand, b.items, b.on_sale, b.min_price,
         case when x.brand is null then '{}' else x.terms end,
         m.in_orig, m.in_ours, m.anywhere, m.min_price, m.link,
         case
           when x.brand is null and x.intent = 'brand' then 'brand_query'
           -- upit o brendu koji klijent ne prodaje: AI ga ne bi smeo preporučiti
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
      select count(*)::int items, count(*) filter (where c.sale_price is not null)::int on_sale, min(coalesce(c.sale_price, c.price)) min_price
        from public.catalog_products c where c.workspace_id = p_ws and c.brand = x.brand
    ) b on x.brand is not null
    left join lateral public._model_hits(p_ws, x.brand, x.terms) m on x.brand is not null and cardinality(x.terms) > 0;
$$;

-- 2) Koje stranice klijenta AI čita i citira, po vrsti stranice i hostu
create or replace function public.get_own_pages(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (host text, page_type text, reads int, cited int, urls int, in_catalog int, examples text[])
language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  dom as (select unnest(domains) d from public.brands where workspace_id = p_ws and is_own),
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
           exists (select 1 from public.catalog_products c where c.workspace_id = p_ws
                    and regexp_replace(c.link, '^https?://[^/]+', '') = regexp_replace(s.url, '^https?://[^/]+', '')) in_cat
      from s
  )
  select host, page_type, count(*)::int, count(*) filter (where cited)::int, count(distinct url)::int,
         count(distinct url) filter (where in_cat)::int, (array_agg(distinct url))[1:5]
    from t group by host, page_type order by count(*) desc;
$$;

-- 3) Fan-out: šta AI pretražuje o brendovima iz kataloga i da li nazivi proizvoda to sadrže
create or replace function public.get_catalog_fanout(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (query text, times int, prompts int, brand text, terms text[], model_in_orig int, model_in_ours int, model_anywhere int, brand_items int)
language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  q as (
    select public._norm(sq.query) nq, min(sq.query) query, count(*)::int times, count(distinct r.prompt_id)::int prompts
      from public.search_queries sq join r on r.id = sq.response_id
     group by 1
  ),
  -- pretrage koje istražuju konkurente ("Buzz BiH Calvin Klein", "site:n-sport.net …") nisu o katalogu klijenta
  comp as (select public._norm(n) n from public.brands b, unnest(array[b.name] || b.aliases || b.domains) n where b.workspace_id = p_ws and not b.is_own),
  b as (select q.*, public._catalog_brand(p_ws, q.query) brand from q
         where not exists (select 1 from comp where comp.n <> '' and position(' ' || comp.n || ' ' in ' ' || q.nq || ' ') > 0)),
  t as (select b.*, public._model_terms(b.query, b.brand) terms from b where b.brand is not null)
  select t.query, t.times, t.prompts, t.brand, t.terms, m.in_orig, m.in_ours, m.anywhere,
         (select count(*)::int from public.catalog_products c where c.workspace_id = p_ws and c.brand = t.brand)
    from t left join lateral public._model_hits(p_ws, t.brand, t.terms) m on cardinality(t.terms) > 0
   order by t.times desc, t.query;
$$;

-- 4) Šta AI kaže da klijent prodaje (odgovori na upite o samom klijentu) naspram kataloga
create or replace function public.get_ai_assortment_claims(p_ws uuid, p_run uuid default null, p_market text default null)
returns table (brand text, in_catalog boolean, catalog_items int, answers_mentioning int, answers_total int)
language sql stable as $$
  with r as (select * from public._resp(p_ws, p_run, null, p_market)),
  own as (select id from public.brands where workspace_id = p_ws and is_own),
  own_names as (select public._norm(n) n from public.brands b, unnest(array[b.name] || b.aliases) n where b.workspace_id = p_ws and b.is_own),
  comp_names as (select public._norm(n) n from public.brands b, unnest(array[b.name] || b.aliases) n where b.workspace_id = p_ws and not b.is_own),
  ra as (
    select r.id, r.answer,
           exists (select 1 from comp_names c where c.n <> '' and position(' ' || c.n || ' ' in ' ' || public._norm(p.text) || ' ') > 0) vs_comp
      from r join public.prompts p on p.id = r.prompt_id
     where p.intent = 'brand' and exists (select 1 from public.mentions m where m.response_id = r.id and m.brand_id in (select id from own))
  ),
  -- upit samo o klijentu: ceo odgovor. Poređenje sa konkurentom ("F&F ili Buzz"): samo rečenice/redovi u kojima je klijent,
  -- jer se Nike u takvom odgovoru odnosi na Buzz, ne na F&F.
  a as (
    select ra.id, string_agg(public._norm(par), ' | ') na
      from ra, regexp_split_to_table(ra.answer, case when ra.vs_comp then '\n|[.!?]\s+' else '$^' end) par  -- '$^' se nikad ne poklapa = ceo odgovor
     where not ra.vs_comp
        or exists (select 1 from own_names o where o.n <> '' and position(replace(o.n, ' ', '') in replace(public._norm(par), ' ', '')) > 0)
     group by ra.id
  ),
  cat as (select brand, nbrand, count(*)::int items from public.catalog_products where workspace_id = p_ws and nbrand <> '' group by brand, nbrand),
  -- poznati modni brendovi koje vredi proveriti i kad ih klijent nema u katalogu
  ref(name) as (values ('Nike'),('Adidas'),('Puma'),('Converse'),('Vans'),('Reebok'),('Lacoste'),('Ralph Lauren'),('Michael Kors'),('Furla'),
                       ('Napapijri'),('The North Face'),('Columbia'),('Skechers'),('Max Mara'),('Pinko'),('Twinset'),('Gant'),('Pepe Jeans'),('Mango'),('Zara'),
                       ('Golden Goose'),('Saucony'),('Karl Lagerfeld'),('Off-White'),('Stone Island'),('Polo Ralph Lauren')),
  allb as (
    select brand, nbrand, true in_cat, items from cat
    union all
    select ref.name, public._norm(ref.name), false, 0 from ref
     where not exists (select 1 from cat where position(' ' || public._norm(ref.name) || ' ' in ' ' || cat.nbrand || ' ') > 0)
  )
  select allb.brand, allb.in_cat, allb.items,
         (select count(*)::int from a where position(' ' || allb.nbrand || ' ' in ' ' || a.na || ' ') > 0),
         (select count(*)::int from a)
    from allb order by 4 desc, 3 desc;
$$;
