import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApp } from "../lib/ctx";
import { Brand, MARKETS, supabase } from "../lib/supabase";
import { PV } from "../components/Filters";

interface Src { id: string; url: string; domain: string; title: string | null; snippet: string | null; query_idx: number | null; retrieved_rank: number | null; cited: boolean; citation_count: number; first_cited_pos: number | null }
interface Cit { id: string; source_id: string | null; start_index: number | null; end_index: number | null; answer_text: string | null; cited_text: string | null }
interface Men { brand_id: string; mention_count: number; rank: number; linked: boolean; sentiment: string | null; recommended: boolean | null; context: string | null; reasons: string[] | null }
interface Resp { id: string; provider: string; model: string | null; market: string; answer: string | null; status: string; error: string | null; used_search: boolean | null; latency_ms: number | null; discovered_brands: string[]; prompts: { text: string } | null }

type Hover = { kind: "q"; idx: number } | { kind: "s"; id: string } | null;

const SENT: Record<string, string> = { positive: "pozitivno", neutral: "neutralno", negative: "negativno", mixed: "mešovito" };

// Proširi kratke citate (npr. "[1]" ili link na kraju rečenice) na celu rečenicu
function widen(text: string, s: number, e: number): [number, number] {
  if (e - s >= 40) return [s, e];
  let i = s;
  while (i > 0 && !/[.!?\n]/.test(text[i - 1])) i--;
  while (i < s && /\s/.test(text[i])) i++;
  return [i, e];
}

function brandRanges(text: string, brands: Brand[]) {
  const out: { s: number; e: number; brand: Brand }[] = [];
  for (const b of brands) {
    for (const t of [b.name, ...b.aliases].filter((x) => x.length >= 2)) {
      const stem = t.length >= 4 && /a$/i.test(t) ? t.slice(0, -1) : t;
      const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s*&\s*/g, "\\s*&\\s*");
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}[\\p{L}-]{0,4}`, "giu");
      for (const m of text.matchAll(re)) out.push({ s: m.index!, e: m.index! + m[0].length, brand: b });
    }
  }
  return out;
}

export default function Trace() {
  const { id } = useParams();
  const { brands } = useApp();
  const [r, setR] = useState<Resp | null>(null);
  const [queries, setQueries] = useState<{ idx: number; query: string }[]>([]);
  const [sources, setSources] = useState<Src[]>([]);
  const [cits, setCits] = useState<Cit[]>([]);
  const [mentions, setMentions] = useState<Men[]>([]);
  const [hover, setHover] = useState<Hover>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      supabase.from("responses").select("id,provider,model,market,answer,status,error,used_search,latency_ms,discovered_brands,prompts(text)").eq("id", id).single(),
      supabase.from("search_queries").select("idx,query").eq("response_id", id).order("idx"),
      supabase.from("sources").select("*").eq("response_id", id),
      supabase.from("citations").select("*").eq("response_id", id),
      supabase.from("mentions").select("*").eq("response_id", id).order("rank"),
    ]).then(([a, b, c, d, e]) => {
      setR(a.data as any); setQueries(b.data ?? []); setSources(c.data ?? []); setCits(d.data ?? []); setMentions(e.data ?? []);
    });
  }, [id]);

  const answer = r?.answer ?? "";
  const cited = sources.filter((s) => s.cited).sort((a, b) => (a.first_cited_pos ?? 1e9) - (b.first_cited_pos ?? 1e9));
  const notCited = sources.filter((s) => !s.cited).sort((a, b) => (a.query_idx ?? 99) - (b.query_idx ?? 99) || (a.retrieved_rank ?? 99) - (b.retrieved_rank ?? 99));
  const citeNo = useMemo(() => new Map(cited.map((s, i) => [s.id, i + 1])), [cited]);

  // Segmenti odgovora: koji izvori i koji brend pokrivaju svaki deo teksta
  const segments = useMemo(() => {
    if (!answer) return [];
    const n = answer.length;
    const srcAt: string[][] = Array.from({ length: n }, () => []);
    for (const c of cits) {
      if (c.start_index == null || c.end_index == null || !c.source_id) continue;
      const [s, e] = widen(answer, Math.max(0, c.start_index), Math.min(n, c.end_index));
      for (let i = s; i < e; i++) if (!srcAt[i].includes(c.source_id)) srcAt[i].push(c.source_id);
    }
    const brandAt: (Brand | null)[] = Array(n).fill(null);
    for (const br of brandRanges(answer, brands)) for (let i = br.s; i < br.e && i < n; i++) brandAt[i] = br.brand;
    const segs: { text: string; srcs: string[]; brand: Brand | null }[] = [];
    let cur = { text: "", srcs: srcAt[0], brand: brandAt[0] };
    for (let i = 0; i < n; i++) {
      if (srcAt[i].join() !== cur.srcs.join() || brandAt[i] !== cur.brand) {
        if (cur.text) segs.push(cur);
        cur = { text: "", srcs: srcAt[i], brand: brandAt[i] };
      }
      cur.text += answer[i];
    }
    if (cur.text) segs.push(cur);
    return segs;
  }, [answer, cits, brands]);

  if (!r) return <p className="muted">Učitavanje…</p>;

  const isOnQ = (s: Src) => hover?.kind === "q" && s.query_idx === hover.idx;
  const srcOn = (s: Src) => (hover?.kind === "s" && hover.id === s.id) || isOnQ(s);
  const hoveredSrc = hover?.kind === "s" ? sources.find((s) => s.id === hover.id) : null;
  const qOn = (idx: number) => (hover?.kind === "q" && hover.idx === idx) || hoveredSrc?.query_idx === idx;
  const dim = (s: Src) => hover?.kind === "q" && s.query_idx !== hover.idx;
  const visibleNotCited = showAll ? notCited : notCited.slice(0, 12);
  const brandOf = (bid: string) => brands.find((b) => b.id === bid);

  const SrcRow = ({ s }: { s: Src }) => (
    <a href={s.url} target="_blank" rel="noreferrer"
      className={"src" + (s.cited ? " cited" : "") + (srcOn(s) ? " on" : "") + (dim(s) ? " dim" : "")}
      onMouseEnter={() => setHover({ kind: "s", id: s.id })} onMouseLeave={() => setHover(null)}
      style={{ color: "inherit", textDecoration: "none" }}>
      <span className="d">{s.cited && <b style={{ color: "var(--cite)" }}>[{citeNo.get(s.id)}] </b>}{s.domain}</span>
      <span className="n">{s.cited ? `${s.citation_count}× citiran` : s.retrieved_rank ? `#${s.retrieved_rank}` : ""}</span>
      {s.title && s.title !== s.domain && <span className="t">{s.title}</span>}
    </a>
  );

  return (
    <>
      <div className="pagehead">
        <div>
          <p className="small"><Link to="/odgovori">Svi odgovori</Link></p>
          <h1 style={{ marginTop: 4 }}>Put do odgovora</h1>
          <p><PV p={r.provider} /> <span className="faint">{r.model}, {MARKETS.find((m) => m.id === r.market)?.label}{r.latency_ms ? `, ${(r.latency_ms / 1000).toFixed(1)} s` : ""}</span></p>
        </div>
      </div>

      {r.status === "error" && <div className="empty err" style={{ marginBottom: 16 }}>{r.error}</div>}
      {r.status === "empty" && <div className="empty" style={{ marginBottom: 16 }}>Google za ovu pretragu nije prikazao AI Overview. Ispod su organski rezultati koje je Google rangirao.</div>}

      <div className="funnel" role="list">
        <div role="listitem"><b>{queries.length}</b><span>{r.used_search === false ? "nije pretraživao web" : "pretraga na webu"}</span></div>
        <div role="listitem"><b>{sources.length}</b><span>stranica pročitano</span></div>
        <div role="listitem"><b>{cited.length}</b><span>citirano u odgovoru</span></div>
        <div role="listitem"><b>{mentions.length}</b><span>praćenih brendova pomenuto</span></div>
      </div>

      <div className="trace">
        <div className="lane">
          <h3>Pitanje</h3>
          <div className="prompt-box">{r.prompts?.text}</div>
          <h3>Šta je AI tražio <small>{queries.length}</small></h3>
          {!queries.length && <p className="muted small">{r.provider === "perplexity" ? "Perplexity ne otkriva svoje pretrage, vide se samo izvori." : r.used_search === false ? "Odgovorio iz sopstvenog znanja, bez pretrage." : "Nema podataka o pretragama."}</p>}
          {queries.map((q) => (
            <div key={q.idx} className={"q" + (qOn(q.idx) ? " on" : "")} onMouseEnter={() => setHover({ kind: "q", idx: q.idx })} onMouseLeave={() => setHover(null)}>
              <span className="qn">{q.idx + 1}</span>{q.query}
              <div className="small faint">{sources.filter((s) => s.query_idx === q.idx).length} rezultata</div>
            </div>
          ))}
        </div>

        <div className="lane">
          <h3>Citirano <small>{cited.length}</small></h3>
          {!cited.length && <p className="muted small">Odgovor ne citira nijedan izvor.</p>}
          {cited.map((s) => <SrcRow key={s.id} s={s} />)}
          <h3 style={{ marginTop: 18 }}>Pročitano, nije citirano <small>{notCited.length}</small></h3>
          {visibleNotCited.map((s) => <SrcRow key={s.id} s={s} />)}
          {notCited.length > 12 && <button className="btn ghost small" onClick={() => setShowAll(!showAll)}>{showAll ? "Prikaži manje" : `Prikaži još ${notCited.length - 12}`}</button>}
        </div>

        <div className="lane">
          <h3>Odgovor</h3>
          {!answer ? <p className="muted">Nema teksta odgovora.</p> : (
            <div className="answer">
              {segments.map((sg, i) => {
                let node: React.ReactNode = sg.text;
                if (sg.brand) node = <b className={"brand" + (sg.brand.is_own ? " own" : "")}>{node}</b>;
                if (sg.srcs.length) {
                  const on = hover?.kind === "s" && sg.srcs.includes(hover.id);
                  const label = sg.srcs.map((x) => `[${citeNo.get(x) ?? "?"}] ${sources.find((s) => s.id === x)?.domain}`).join("\n");
                  node = <mark className={on ? "on" : ""} title={label} onMouseEnter={() => setHover({ kind: "s", id: sg.srcs[0] })} onMouseLeave={() => setHover(null)}>{node}</mark>;
                }
                return <Fragment key={i}>{node}</Fragment>;
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <section className="panel">
          <h2>Kako predstavlja brendove</h2>
          <p className="sub">Redosled pominjanja, ton i razlozi zbog kojih AI navodi brend.</p>
          {!mentions.length ? <p className="muted small">Nijedan praćeni brend nije pomenut.</p> : (
            <table>
              <tbody>
                {mentions.map((m) => {
                  const b = brandOf(m.brand_id);
                  return (
                    <tr key={m.brand_id} className={b?.is_own ? "own" : ""}>
                      <td style={{ width: 28 }}>{m.rank}.</td>
                      <td>
                        <div><b style={{ fontWeight: 500 }}>{b?.name}</b>{" "}
                          {m.sentiment && <span className={"tag" + (m.sentiment === "positive" ? " pos" : m.sentiment === "negative" ? " neg" : "")}>{SENT[m.sentiment]}</span>}
                          {m.recommended && <span className="tag own">preporučen</span>}
                          {m.linked && <span className="tag cite">citiran sajt</span>}
                        </div>
                        {m.reasons?.length ? <div className="small muted">{m.reasons.join(", ")}</div> : null}
                        {m.context && <div className="small" style={{ fontFamily: "var(--read)", marginTop: 4 }}>„{m.context}”</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {r.discovered_brands?.length > 0 && (
            <p className="small" style={{ marginTop: 12 }}><span className="muted">Pominje i: </span>{r.discovered_brands.join(", ")}</p>
          )}
        </section>

        <section className="panel">
          <h2>Šta je preuzeto iz izvora</h2>
          <p className="sub">Deo odgovora i izvor na koji se oslanja{r.provider === "claude" || r.provider === "google_aio" ? ", sa tačnim citiranim tekstom" : ""}.</p>
          {!cits.length ? <p className="muted small">Nema citata.</p> : (
            <div className="stack">
              {cits.slice(0, 30).map((c) => {
                const s = sources.find((x) => x.id === c.source_id);
                return (
                  <div key={c.id} onMouseEnter={() => s && setHover({ kind: "s", id: s.id })} onMouseLeave={() => setHover(null)}>
                    <div className="small"><b style={{ color: "var(--cite)" }}>[{s ? citeNo.get(s.id) : "?"}]</b> {s?.domain}</div>
                    {c.answer_text && <div style={{ fontFamily: "var(--read)" }}>{c.answer_text.slice(0, 260)}{c.answer_text.length > 260 ? "…" : ""}</div>}
                    {c.cited_text && <div className="small muted" style={{ borderLeft: "2px solid var(--cite)", paddingLeft: 8, marginTop: 4 }}>{c.cited_text}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
