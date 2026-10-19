import { Fragment, useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/ctx";
import { rpc, supabase } from "../lib/supabase";
import { Filters, NoData } from "../components/Filters";

// Ukrštanje kataloga klijenta (iz Agent Feeda) sa AI odgovorima: upiti, fan-out pretrage, izvori, šta AI tvrdi da klijent prodaje.

interface Fit {
  prompt_id: string; prompt: string; market: string; intent: string | null; answers: number; own_mentioned: number; own_rate: number | null;
  competitors: string[]; brand: string | null; brand_items: number | null; brand_on_sale: number | null; brand_min_price: number | null;
  model_terms: string[]; model_in_orig: number | null; model_in_ours: number | null; model_anywhere: number | null; model_min_price: number | null;
  sample_link: string | null; verdict: Verdict;
}
type Verdict = "gap" | "model_fixed" | "model_hidden" | "model_missing" | "false_claim" | "not_carried" | "ok" | "general" | "brand_query";
interface Page { host: string; page_type: string; reads: number; cited: number; urls: number; in_catalog: number; examples: string[] }
interface Fan { query: string; times: number; prompts: number; brand: string; terms: string[]; model_in_orig: number | null; model_in_ours: number | null; model_anywhere: number | null; brand_items: number }
interface Claim { brand: string; in_catalog: boolean; catalog_items: number; answers_mentioning: number; answers_total: number }

const VERDICT: Record<Verdict, { label: string; cls: string; order: number }> = {
  false_claim: { label: "AI vas preporučuje za brend koji ne prodajete", cls: "sev crit", order: 0 },
  gap: { label: "Imate robu, a AI vas retko pominje", cls: "sev crit", order: 1 },
  model_hidden: { label: "Imate model, ali ga naziv ne pominje", cls: "sev high", order: 2 },
  model_fixed: { label: "Imate model; Agent Feed ga sada dodaje u naziv", cls: "sev ok", order: 3 },
  model_missing: { label: "Model nije u katalogu", cls: "sev low", order: 4 },
  not_carried: { label: "Ne prodajete ovaj brend", cls: "sev low", order: 5 },
  ok: { label: "U redu", cls: "sev ok", order: 6 },
  brand_query: { label: "Upit o vama", cls: "sev low", order: 7 },
  general: { label: "Opšti upit", cls: "sev low", order: 8 },
};
const PAGE: Record<string, { label: string; tip: string }> = {
  product: { label: "Proizvod", tip: "Ovo AI treba da čita: cena, veličine, dostupnost." },
  category: { label: "Kategorija / brend", tip: "Dobro za upite „gde kupiti X“; treba da ima tekst o brendu i link ka proizvodima." },
  filter: { label: "Filter (boja, veličina, sortiranje)", tip: "Duplikati kategorija; trošak čitanja bez vrednosti. Canonical ka kategoriji ili noindex." },
  pdf: { label: "PDF (pravni dokumenti)", tip: "Obrasci i politika privatnosti; AI ih čita, ali nikad ne citira. Isključiti iz indeksiranja." },
  info: { label: "Info (o nama, prodavnice, kontakt)", tip: "AI ih citira gotovo uvek; držati ažurnim (radno vreme, adrese, dostava, povrat)." },
  home: { label: "Početna", tip: "" },
};
const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("sr-Latn-RS"));

export default function Crossing() {
  const { ws, runId, market, brands } = useApp();
  const [fit, setFit] = useState<Fit[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [fan, setFan] = useState<Fan[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const [modelsAdded, setModelsAdded] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const own = brands.find((b) => b.is_own)?.name ?? "klijent";

  useEffect(() => {
    if (!ws) return;
    setLoading(true);
    const a = { p_ws: ws.id, p_run: runId, p_market: market };
    Promise.all([
      rpc<Fit>("get_catalog_prompt_fit", a),
      rpc<Page>("get_own_pages", a),
      rpc<Fan>("get_catalog_fanout", a),
      rpc<Claim>("get_ai_assortment_claims", a),
      supabase.from("catalog_products").select("product_id", { count: "exact", head: true }).eq("workspace_id", ws.id),
      supabase.from("agent_feeds").select("stats").eq("workspace_id", ws.id),
    ]).then(([f, p, q, c, cnt, af]) => {
      setFit(f); setPages(p); setFan(q); setClaims(c);
      setCatalogCount(cnt.count ?? null);
      setModelsAdded((af.data ?? []).reduce((s: number, r: any) => s + (r.stats?.models_added ?? 0), 0) || null);
    }).finally(() => setLoading(false));
  }, [ws, runId, market]);

  const sortedFit = useMemo(() => [...fit].sort((x, y) => VERDICT[x.verdict].order - VERDICT[y.verdict].order || (x.own_rate ?? 0) - (y.own_rate ?? 0)), [fit]);
  const shownFit = showAll ? sortedFit : sortedFit.filter((f) => !["ok", "general", "brand_query"].includes(f.verdict));
  const fanModels = fan.filter((f) => f.terms.length > 0);
  const wrongClaims = claims.filter((c) => !c.in_catalog && c.answers_mentioning > 0);
  const unknownBrands = claims.filter((c) => c.in_catalog && c.answers_mentioning === 0 && c.catalog_items >= 50).sort((a, b) => b.catalog_items - a.catalog_items);
  const answersAboutOwn = claims[0]?.answers_total ?? 0;

  const pageTotals = useMemo(() => {
    const by = new Map<string, { reads: number; cited: number; urls: number }>();
    for (const p of pages) {
      const t = by.get(p.page_type) ?? { reads: 0, cited: 0, urls: 0 };
      t.reads += p.reads; t.cited += p.cited; t.urls += p.urls;
      by.set(p.page_type, t);
    }
    return by;
  }, [pages]);
  const totalReads = [...pageTotals.values()].reduce((s, t) => s + t.reads, 0);
  const wasteReads = (pageTotals.get("filter")?.reads ?? 0) + (pageTotals.get("pdf")?.reads ?? 0);
  const productReads = pageTotals.get("product")?.reads ?? 0;
  const mainHost = pages.length ? [...pages].sort((a, b) => b.reads - a.reads)[0].host : "";
  const strayHosts = [...new Set(pages.map((p) => p.host))].filter((h) => h !== mainHost && !/assets/.test(h));

  const count = (v: Verdict[]) => fit.filter((f) => v.includes(f.verdict)).length;

  if (loading) return <p className="muted">Učitavanje…</p>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Ukrštanje: katalog × AI odgovori</h1>
          <p>Šta {own} prodaje (feed) naspram onoga što AI odgovara, pretražuje, čita i tvrdi. Ovde se vidi gde AI ne zna za robu koju imate i zašto.</p>
        </div>
        <Filters />
      </div>

      {catalogCount === 0 ? (
        <NoData>Katalog još nije učitan. Puni ga Agent Feed pri svakom objavljivanju (Actions → Agent Feed → Run workflow).</NoData>
      ) : !fit.length ? <NoData /> : (
        <div className="stack">
          <section className="panel">
            <h2>Najveće prilike</h2>
            <p className="sub">Iz {fit.length} upita, {fan.length} AI pretraga o vašim brendovima i {totalReads} čitanja vašeg sajta, ukršteno sa {n0(catalogCount)} proizvoda u katalogu.</p>
            <div className="xr-kpis">
              <Kpi v={String(count(["gap"]))} l="upita gde imate robu, a AI vas retko pominje" />
              <Kpi v={String(count(["model_fixed", "model_hidden"]))} l="traženih modela koje imate, a naziv ih nije pominjao" />
              {modelsAdded != null && <Kpi v={n0(modelsAdded)} l="proizvoda kojima Agent Feed dodaje model u naziv" />}
              <Kpi v={String(wrongClaims.length)} l="brendova koje AI pogrešno navodi da prodajete" />
              <Kpi v={String(unknownBrands.length)} l="vaših brendova (50+ artikala) koje AI ne pominje" />
              <Kpi v={totalReads ? `${Math.round((100 * wasteReads) / totalReads)}%` : "—"} l="AI čitanja sajta na filterima i PDF-ovima" />
            </div>
          </section>

          <section className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h2>Upiti × katalog</h2>
                <p className="sub">Za svaki upit: da li ga AI vezuje za vas, da li imate robu i da li je naziv proizvoda takav da ga AI pronađe.</p>
              </div>
              <label className="chk"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Prikaži i upite koji su u redu ({fit.length})</label>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Nalaz</th><th>Upit</th><th className="num">Pominje vas</th><th>Vaš katalog</th><th>Konkurenti u odgovorima</th></tr></thead>
                <tbody>
                  {shownFit.map((f) => (
                    <Fragment key={f.prompt_id}>
                      <tr className="click" onClick={() => setOpen(open === f.prompt_id ? null : f.prompt_id)}>
                        <td style={{ minWidth: 190 }}><span className={VERDICT[f.verdict].cls}>{VERDICT[f.verdict].label}</span></td>
                        <td>{f.prompt}<div className="small muted">{f.market}{f.intent ? ` · ${f.intent}` : ""}</div></td>
                        <td className="num">{f.own_mentioned}/{f.answers}</td>
                        <td className="small">
                          {f.brand ? <>{f.brand}: <b>{n0(f.brand_items)}</b> art.{f.brand_on_sale ? `, ${n0(f.brand_on_sale)} na popustu` : ""}{f.brand_min_price ? `, od ${n0(f.brand_min_price)}` : ""}</> : <span className="muted">—</span>}
                          {f.model_terms.length > 0 && (
                            <div>Model „{f.model_terms.join(" ")}“: {f.model_anywhere ? <><b>{f.model_anywhere}</b> art. (u vašem nazivu {f.model_in_orig}, u našem {f.model_in_ours})</> : "nema"}</div>
                          )}
                        </td>
                        <td className="small">{f.competitors.slice(0, 5).join(", ")}{f.competitors.length > 5 ? ` +${f.competitors.length - 5}` : ""}</td>
                      </tr>
                      {open === f.prompt_id && (
                        <tr><td colSpan={5} style={{ background: "var(--sunk)" }}>
                          <div className="xr-detail">
                            <p>{advice(f, own)}</p>
                            {f.sample_link && <p className="small">Primer proizvoda: <a href={f.sample_link} target="_blank" rel="noreferrer">{f.sample_link}</a></p>}
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid2">
            <section className="panel">
              <h2>Šta AI kaže da prodajete</h2>
              <p className="sub">Brendovi u {answersAboutOwn} odgovora na pitanja o vama (kod poređenja sa konkurentom samo rečenice o vama).</p>
              {wrongClaims.length > 0 && (
                <>
                  <h3 style={{ marginTop: 6 }}><span className="sev crit">✕ Navodi, a nemate u katalogu</span></h3>
                  <table><tbody>{wrongClaims.map((c) => <tr key={c.brand}><td>{c.brand}</td><td className="num">{c.answers_mentioning}/{c.answers_total} odg.</td></tr>)}</tbody></table>
                </>
              )}
              {unknownBrands.length > 0 && (
                <>
                  <h3 style={{ marginTop: 14 }}><span className="sev high">▲ Prodajete, a AI ne pominje</span></h3>
                  <table><tbody>{unknownBrands.slice(0, 10).map((c) => <tr key={c.brand}><td>{c.brand}</td><td className="num">{n0(c.catalog_items)} art.</td></tr>)}</tbody></table>
                </>
              )}
              <p className="small muted" style={{ marginTop: 10 }}>Pogrešni brendovi obično dolaze iz tuđih izvora (sajtovi sa sličnim imenom, stari članci). Rešenje: stranica „Brendovi“ sa tačnim spiskom i schema.org Brand na sajtu.</p>
            </section>

            <section className="panel">
              <h2>Koje vaše stranice AI čita</h2>
              <p className="sub">{totalReads} čitanja, od toga {productReads} na proizvodima. Citiran = AI se pozvao na tu stranicu u odgovoru.</p>
              <table>
                <thead><tr><th>Vrsta</th><th className="num">Čitanja</th><th className="num">Citirano</th></tr></thead>
                <tbody>
                  {[...pageTotals.entries()].sort((a, b) => b[1].reads - a[1].reads).map(([t, v]) => (
                    <tr key={t}>
                      <td>{PAGE[t]?.label ?? t}<div className="small muted">{PAGE[t]?.tip}</div></td>
                      <td className="num">{v.reads}</td>
                      <td className="num">{v.cited} <span className="small muted">({v.reads ? Math.round((100 * v.cited) / v.reads) : 0}%)</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {strayHosts.length > 0 && (
                <p className="small" style={{ marginTop: 10 }}><span className="sev crit">✕</span> AI čita i <b>{strayHosts.join(", ")}</b>. Ako je to interni/test server, treba ga zatvoriti za indeksiranje (noindex ili lozinka), inače se takmiči sa glavnim sajtom.</p>
              )}
            </section>
          </div>

          <section className="panel">
            <h2>Šta AI pretražuje o vašim brendovima</h2>
            <p className="sub">Pretrage koje je AI sam napravio (fan-out) sa nazivom modela, i da li vaš katalog ima taj model i pod kojim nazivom. Pretrage o konkurentima su izostavljene.</p>
            {!fanModels.length ? <p className="muted small">Nema pretraga sa nazivom modela.</p> : (
              <div className="tablewrap">
                <table>
                  <thead><tr><th>AI pretraga</th><th className="num">Puta</th><th>Brend</th><th>Model u katalogu</th></tr></thead>
                  <tbody>
                    {fanModels.slice(0, 30).map((f) => (
                      <tr key={f.query}>
                        <td>{f.query}</td>
                        <td className="num">{f.times}</td>
                        <td>{f.brand} <span className="small muted">({n0(f.brand_items)})</span></td>
                        <td className="small">
                          {!f.model_anywhere ? <span className="muted">nema „{f.terms.join(" ")}“</span>
                            : f.model_in_orig ? <span className="sev ok">✓ {f.model_anywhere} art., u nazivu</span>
                            : f.model_in_ours ? <span className="sev ok">✓ {f.model_anywhere} art. — Agent Feed dodaje u naziv</span>
                            : <span className="sev high">▲ {f.model_anywhere} art., samo u opisu</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function Kpi({ v, l }: { v: string; l: string }) {
  return <div className="xr-kpi"><b>{v}</b><span>{l}</span></div>;
}

function advice(f: Fit, own: string): string {
  const price = f.model_min_price ?? f.brand_min_price;
  switch (f.verdict) {
    case "gap":
      return `${own} ima ${n0(f.brand_items)} artikala brenda ${f.brand}${price ? ` (od ${n0(price)} RSD)` : ""}, a AI ga pominje u ${f.own_mentioned} od ${f.answers} odgovora. AI umesto toga navodi: ${f.competitors.join(", ") || "druge prodavce"}. Proverite da li AI agenti mogu da otvore sajt (Feed X-ray), da li stranica brenda ima tekst i da li feed ima ispravne nazive.`;
    case "model_fixed":
      return `Model „${f.model_terms.join(" ")}“ postoji u katalogu (${f.model_anywhere} art.), ali ga naziv u vašem feedu nije pominjao, pa ga AI i Google ne povezuju sa vama. Agent Feed sada dodaje model u naziv. Isto treba uraditi i u Magentu (naziv proizvoda na sajtu).`;
    case "model_hidden":
      return `Model „${f.model_terms.join(" ")}“ se pominje samo u opisu ${f.model_anywhere} artikala. Dodati ga u naziv proizvoda.`;
    case "model_missing":
      return `U katalogu nema modela „${f.model_terms.join(" ")}“. Ako ga ne prodajete, upit nije prioritet; ako ga prodajete pod drugim imenom, dodati to ime u naziv.`;
    case "false_claim":
      return `AI preporučuje ${own} za brend koji nije u katalogu. Kupac koji dođe sa tim očekivanjem odlazi razočaran. Proverite izvore koje AI citira (stranica Izvori) i objavite tačan spisak brendova.`;
    case "not_carried":
      return "Brend nije u vašem katalogu i AI vas ne pominje, što je ispravno. Ovaj upit može da se izbaci iz praćenja ili zameni brendom koji prodajete.";
    default:
      return f.brand ? `${own} ima ${n0(f.brand_items)} artikala brenda ${f.brand} i AI vas pominje u ${f.own_mentioned} od ${f.answers} odgovora.` : "Opšti upit bez brenda iz kataloga.";
  }
}
