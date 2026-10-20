-- Feed pre/posle: šta klijentov feed kaže o proizvodu naspram našeg Agent Feeda i sajta.
-- Kolone puni Agent Feed (build.mjs) pri svakom objavljivanju, zajedno sa ostatkom catalog_products.

alter table public.catalog_products
  add column if not exists feed_size text,             -- veličina u klijentovom feedu (Magento izvozi jednu)
  add column if not exists feed_gpc text,              -- google_product_category u klijentovom feedu
  add column if not exists gpc text,                   -- google_product_category u našem feedu
  add column if not exists orig_product_type text,     -- kategorija u klijentovom feedu
  add column if not exists age_group text,
  add column if not exists image_link text,
  add column if not exists sizes_source text;          -- 'site' = veličine pročitane sa stranice proizvoda, 'feed' = iz feeda

alter table public.catalog_products
  add column if not exists size_gap boolean generated always as (sizes_source = 'site' and cardinality(sizes) > 1) stored,
  add column if not exists title_changed boolean generated always as (title is distinct from orig_title) stored;

create index if not exists catalog_products_size_gap on public.catalog_products(workspace_id) where size_gap;

-- Zbirni brojevi i pregled po brendu za stranicu "Feed pre/posle"
create or replace function public.get_feed_compare_summary(p_ws uuid)
returns table (products int, size_gap int, site_sizes int, feed_gpc int, our_gpc int, titles_changed int, cats_changed int, updated_at timestamptz, brands jsonb)
language sql stable as $$
  with c as (select * from public.catalog_products where workspace_id = p_ws),
  b as (
    select brand, count(*)::int as products, count(*) filter (where size_gap)::int as size_gap,
           mode() within group (order by feed_size) filter (where size_gap) as top_feed_size
      from c where brand is not null group by brand
  )
  select count(*)::int,
         count(*) filter (where size_gap)::int,
         coalesce(sum(cardinality(sizes)) filter (where size_gap), 0)::int,
         count(*) filter (where coalesce(feed_gpc, '') <> '')::int,
         count(*) filter (where coalesce(gpc, '') <> '')::int,
         count(*) filter (where title_changed)::int,
         count(*) filter (where product_type is distinct from orig_product_type and orig_product_type is not null)::int,
         max(c.updated_at),
         (select coalesce(jsonb_agg(to_jsonb(b) order by b.size_gap desc, b.products desc), '[]') from b)
    from c;
$$;
