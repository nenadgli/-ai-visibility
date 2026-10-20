import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useApp } from "../lib/ctx";
import { rpc, supabase } from "../lib/supabase";
import { NoData } from "../components/Filters";

// Feed pre/posle: svaki proizvod iz klijentovog feeda naspram našeg Agent Feeda i sajta (veličine, naziv, Google kategorija).
// Podatke puni Agent Feed u tabelu catalog_products (migracije 006 i 008).

interface Summary { products: number; size_gap: number; site_sizes: number; feed_gpc: number; our_gpc: number; titles_changed: number; cats_changed: number; updated_at: string | null; brands: BrandRow[] }
interface BrandRow { brand: string; products: number; size_gap: number; top_feed_size: string | null }
interface Product {
  product_id: string; title: string; orig_title: string | null; brand: string | null; product_type: string | null; orig_product_type: string | null;
  link: string | null; price: number | null; sale_price: number | null; sizes: string[]; feed_size: string | null; feed_gpc: string | null; gpc: string | null;
  age_group: string | null; image_link: string | null; sizes_source: string | null; size_gap: boolean; title_changed: boolean;
}

const GPC: Record<string, string> = {
  "212": "Odeća > Majice i gornji delovi", "187": "Obuća", "204": "Odeća > Pantalone", "5598": "Odeća > Jakne i kaputi", "3032": "Torbe",
  "213": "Odeća > Veš i čarape", "2271": "Odeća > Haljine", "173": "Aksesoari > Kape", "2668": "Novčanici", "477": "Kozmetika > Šminka",
  "209": "Čarape", "169": "Aksesoari > Kaiševi", "1581": "Odeća > Suknje", "2619": "Kozmetika > Pribor", "207": "Odeća > Šortsevi",
  "177": "Aksesoari > Šalovi", "567": "Kozmetika > Nega kože", "167": "Aksesoari", "100": "Torbe > Rančevi", "211": "Odeća > Kupaći",
  "2580": "Odeća > Pidžame", "1604": "Odeća", "103": "Putne torbe", "5250": "Odeća > Kombinezoni", "101": "Laptop torbe",
  "178": "Aksesoari > Naočare", "203": "Odeća > Gornja odeća", "479": "Kozmetika > Parfemi", "108": "Neseseri", "7313": "Odeća > Kompleti", "1594": "Odeća > Odela",
};
const PAGE = 50;
const COLS = "product_id,title,orig_title,brand,product_type,orig_product_type,link,price,sale_price,sizes,feed_size,feed_gpc,gpc,age_group,image_link,sizes_source,size_gap,title_changed";
const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("sr-Latn-RS"));
// isto kao public._norm u bazi: mala slova, bez dijakritika, "Lyle & Scott" = "Lyle&Scott"
const norm = (t: string) => t.toLowerCase().replace(/[čć]/g, "c").replace(/ž/g, "z").replace(/š/g, "s").replace(/đ/g, "d").replace(/['’]/g, "")
  .replace(/\s*&\s*/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();

type Filter = "all" | "sizes" | "titles";

export default function FeedCompare() {
  const { ws } = useApp();
  const [sum, setSum] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [filter, setFilter] = useState<Filter>("sizes");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    rpc<Summary>("get_feed_compare_summary", { p_ws: ws.id }).then((r) => setSum(r[0] ?? null)).catch((e) => setErr(e.message));
  }, [ws]);

  // pretraga kreće 300 ms posle kucanja
  useEffect(() => { const t = setTimeout(() => setQuery(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(0); }, [query, brand, filter, ws]);

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    let req = supabase.from("catalog_products").select(COLS, { count: "exact" }).eq("workspace_id", ws.id);
    if (brand) req = req.eq("brand", brand);
    if (filter === "sizes") req = req.eq("size_gap", true);
    if (filter === "titles") req = req.eq("title_changed", true);
    for (const w of norm(query).split(" ").filter(Boolean)) {
      req = req.or([`ntitle.ilike.*${w}*`, `norig.ilike.*${w}*`, `nbrand.ilike.*${w}*`, ...(/^\d+$/.test(w) ? [`product_id.eq.${w}`] : [])].join(","));
    }
    req.order("size_gap", { ascending: false }).order("brand").order("product_id").range(page * PAGE, page * PAGE + PAGE - 1)
      .then(({ data, count, error }) => {
        if (error) { setErr(error.message); return; }
        setErr(null);
        setRows((data ?? []) as Product[]);
        setTotal(count ?? 0);
        if (data?.length === 1) setOpen((data[0] as Product).product_id);
      })
      .then(() => setLoading(false));
  }, [ws, query, brand, filter, page]);

  if (sum && sum.products === 0) return <NoData>Katalog još nije učitan. Puni ga Agent Feed pri svakom objavljivanju (Actions → Agent Feed → Run workflow).</NoData>;
  const pending = sum != null && sum.size_gap === 0 && sum.our_gpc === 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Feed pre i posle</h1>
          <p>Svaki proizvod iz feeda klijenta naspram našeg Agent Feeda: veličine koje se prodaju na sajtu, naziv i Google kategorija. Osvežava se pri svakom objavljivanju Agent Feeda.</p>
        </div>
      </div>

      {pending && <p className="panel small" style={{ marginBottom: 16 }}>Veličine iz feeda i Google kategorije se upisuju pri sledećem objavljivanju Agent Feeda (svakog sata u :41). Do tada su prikazani samo nazivi.</p>}
      {err && <p className="err" style={{ marginBottom: 16 }}>{err}</p>}

      <div className="stack">
        {sum && (
          <section className="panel">
            <div className="xr-kpis">
              <Kpi v={n0(sum.products)} l="proizvoda u feedu klijenta" />
              <Kpi v={n0(sum.size_gap)} l="proizvoda: feed ima 1 veličinu, sajt prodaje više" />
              <Kpi v={n0(sum.site_sizes)} l="veličina na sajtu za te proizvode (redova u našem feedu)" />
              <Kpi v={`${n0(sum.feed_gpc)} → ${n0(sum.our_gpc)}`} l="proizvoda sa Google kategorijom (njihov → naš feed)" />
              <Kpi v={n0(sum.titles_changed)} l="dopunjenih naziva (brend, model)" />
            </div>
          </section>
        )}

        <section className="panel">
          <div className="filters" style={{ marginBottom: 12 }}>
            <input type="text" aria-label="Pretraga" placeholder="ID, brend ili naziv: 859813, levis 501, timberland" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 280px" }} />
            <select aria-label="Brend" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">Svi brendovi</option>
              {sum?.brands.map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({b.products})</option>)}
            </select>
            {([["sizes", "Razlike u veličinama"], ["titles", "Dopunjeni nazivi"], ["all", "Svi proizvodi"]] as [Filter, string][]).map(([k, l]) => (
              <label key={k} className="chk"><input type="radio" name="fc-filter" checked={filter === k} onChange={() => setFilter(k)} /> {l}</label>
            ))}
          </div>
          <p className="small muted" style={{ marginBottom: 8 }}>{loading ? "Učitavanje…" : `${n0(total)} proizvoda${total > PAGE ? `, strana ${page + 1} od ${pages}` : ""}. Klik na red otvara feed proizvoda.`}</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Proizvod</th><th>Brend</th><th>U feedu klijenta</th><th>Na sajtu se prodaje</th><th>Google kategorija</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <Fragment key={p.product_id}>
                    <tr className="click" onClick={() => setOpen(open === p.product_id ? null : p.product_id)}>
                      <td>
                        {p.title}
                        <div className="small muted">{p.product_id}{p.title_changed && p.orig_title ? ` · kod njih: ${p.orig_title}` : ""}</div>
                      </td>
                      <td>{p.brand}</td>
                      <td>{p.feed_size ? <span className={p.size_gap ? "sev crit" : ""}>samo {p.feed_size}</span> : <span className="muted">—</span>}</td>
                      <td><Sizes p={p} /></td>
                      <td className="small">{p.gpc ? <span className="sev ok">{GPC[p.gpc] ?? p.gpc}</span> : <span className="muted">—</span>}{p.gpc && !p.feed_gpc && <div className="muted">kod njih prazno</div>}</td>
                    </tr>
                    {open === p.product_id && <tr><td colSpan={5} style={{ background: "var(--sunk)" }}><Detail p={p} /></td></tr>}
                  </Fragment>
                ))}
                {!loading && !rows.length && <tr><td colSpan={5} className="muted">Nema proizvoda za ovu pretragu. Probaj samo brend ili ID.</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="filters" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>← Prethodna</button>
              <span className="small muted">{page + 1} / {pages}</span>
              <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Sledeća →</button>
            </div>
          )}
        </section>

        {sum && sum.size_gap > 0 && (
          <section className="panel">
            <h2>Po brendu</h2>
            <p className="sub">Kod koliko proizvoda feed prijavljuje jednu veličinu, a sajt prodaje više. Klik na brend filtrira tabelu iznad.</p>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Brend</th><th className="num">Proizvoda</th><th className="num">Razlika u veličinama</th><th>Najčešća veličina u feedu</th></tr></thead>
                <tbody>
                  {sum.brands.filter((b) => b.size_gap > 0).map((b) => (
                    <tr key={b.brand} className="click" onClick={() => { setBrand(b.brand); setFilter("sizes"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                      <td>{b.brand}</td>
                      <td className="num">{n0(b.products)}</td>
                      <td className="num">{n0(b.size_gap)} <span className="small muted">({Math.round((100 * b.size_gap) / b.products)}%)</span></td>
                      <td>{b.top_feed_size ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function Kpi({ v, l }: { v: string; l: string }) {
  return <div className="xr-kpi"><b>{v}</b><span>{l}</span></div>;
}

function Sizes({ p }: { p: Product }) {
  if (p.sizes_source !== "site") return <span className="small muted">nije još pročitano sa sajta</span>;
  if (!p.sizes.length) return <span className="small muted">nema na stanju</span>;
  return (
    <div className="fc-sz">
      {p.sizes.map((s) => <span key={s} className={p.size_gap && s !== p.feed_size ? "miss" : ""}>{s}</span>)}
    </div>
  );
}

// XML kako ga Google i AI vide: njihov red naspram naših redova (jedan po veličini)
function Detail({ p }: { p: Product }) {
  const price = p.price != null ? `${p.price.toFixed(2)} RSD` : "";
  const catFix = p.orig_product_type != null && p.orig_product_type !== p.product_type;
  const sizes = p.size_gap ? p.sizes : [p.sizes_source === "site" && p.sizes.length ? p.sizes[0] : p.feed_size ?? ""];
  return (
    <div className="fc-detail">
      <div className="fc-cols">
        <section>
          <h3>Feed klijenta <span className="small muted">1 red</span></h3>
          <pre className="fc-xml">
            <T>&lt;item&gt;</T>{"\n"}
            <L t="g:id" v={p.product_id} />
            <L t="title" v={p.orig_title ?? p.title} c={p.title_changed ? "bad" : ""} />
            <L t="g:brand" v={p.brand} />
            <L t="g:size" v={p.feed_size} c={p.size_gap ? "bad" : ""} />
            <L t="g:google_product_category" v={p.feed_gpc} c={p.feed_gpc ? "" : "bad"} />
            <L t="g:product_type" v={p.orig_product_type} c={catFix ? "bad" : ""} />
            <L t="g:price" v={price} />
            {p.size_gap && <span className="fc-cm">  &lt;!-- nema g:item_group_id: Google ne zna da postoje druge veličine --&gt;{"\n"}</span>}
            <T>&lt;/item&gt;</T>
          </pre>
        </section>
        <section>
          <h3>Naš Agent Feed <span className="small muted">{sizes.length} {sizes.length === 1 ? "red" : "redova"}</span></h3>
          <pre className="fc-xml">
            <T>&lt;item&gt;</T>{"\n"}
            <L t="g:id" v={p.size_gap ? `${p.product_id}-${sizes[0]}` : p.product_id} c={p.size_gap ? "good" : ""} />
            {p.size_gap && <L t="g:item_group_id" v={p.product_id} c="good" />}
            <L t="title" v={p.title} c={p.title_changed ? "good" : ""} />
            <L t="g:brand" v={p.brand} />
            <L t="g:size" v={sizes[0]} c={p.size_gap ? "good" : ""} />
            <L t="g:google_product_category" v={p.gpc} c={p.gpc && !p.feed_gpc ? "good" : ""} note={p.gpc ? GPC[p.gpc] : undefined} />
            <L t="g:product_type" v={p.product_type} c={catFix ? "good" : ""} />
            {p.age_group && <L t="g:age_group" v={p.age_group} c="good" />}
            <L t="g:price" v={price} />
            <T>&lt;/item&gt;</T>{"\n"}
            {sizes.slice(1).map((s) => (
              <Fragment key={s}><T>&lt;item&gt;</T> <span className="fc-cm">… isto, samo</span> <T>&lt;g:id&gt;</T><mark className="good">{p.product_id}-{s}</mark><T>&lt;/g:id&gt;</T> <T>&lt;g:size&gt;</T><mark className="good">{s}</mark><T>&lt;/g:size&gt;</T> <T>&lt;/item&gt;</T>{"\n"}</Fragment>
            ))}
          </pre>
        </section>
      </div>
      {p.link && <p className="small"><a href={p.link} target="_blank" rel="noreferrer">Otvori proizvod na sajtu ↗</a></p>}
    </div>
  );
}

function T({ children }: { children: ReactNode }) { return <span className="fc-t">{children}</span>; }
function L({ t, v, c, note }: { t: string; v: string | null | undefined; c?: string; note?: string }) {
  return (
    <>
      {"  "}<T>&lt;{t}&gt;</T>{c ? <mark className={c}>{v || " "}</mark> : v}<T>&lt;/{t}&gt;</T>
      {note && <span className="fc-cm"> &lt;!-- {note} --&gt;</span>}{"\n"}
    </>
  );
}
