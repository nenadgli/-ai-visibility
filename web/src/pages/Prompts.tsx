import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/ctx";
import { MARKETS, Prompt, PROVIDERS, rpc, supabase } from "../lib/supabase";
import { Filters, PV } from "../components/Filters";

interface Cell { prompt_id: string; provider: string; samples: number; own_mentioned: number; own_best_rank: number | null; competitors: string[]; avg_queries: number; avg_cited: number }

export default function Prompts() {
  const { ws, runId, market } = useApp();
  const nav = useNavigate();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [matrix, setMatrix] = useState<Cell[]>([]);
  const [text, setText] = useState("");
  const [mk, setMk] = useState("RS");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!ws) return;
    const { data } = await supabase.from("prompts").select("*").eq("workspace_id", ws.id).order("created_at");
    setPrompts(data ?? []);
    setMatrix(await rpc<Cell>("get_prompt_matrix", { p_ws: ws.id, p_run: runId, p_market: market }));
  }
  useEffect(() => { load(); }, [ws, runId, market]); // eslint-disable-line

  async function add() {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !ws) return;
    setBusy(true);
    await supabase.from("prompts").insert(lines.map((t) => ({ workspace_id: ws.id, text: t, market: mk, topic: topic || null })));
    setText("");
    setBusy(false);
    load();
  }
  async function toggle(p: Prompt) {
    await supabase.from("prompts").update({ active: !p.active }).eq("id", p.id);
    load();
  }
  async function remove(p: Prompt) {
    if (!confirm(`Obrisati upit i sve njegove odgovore?\n\n${p.text}`)) return;
    await supabase.from("prompts").delete().eq("id", p.id);
    load();
  }

  const providers = PROVIDERS.filter((p) => matrix.some((m) => m.provider === p.id));
  const cell = useMemo(() => new Map(matrix.map((m) => [`${m.prompt_id}:${m.provider}`, m])), [matrix]);
  const shown = prompts.filter((p) => !market || p.market === market);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Upiti</h1>
          <p>Pitanja koja vaši kupci postavljaju AI asistentima. Pišite ih kako bi ih kupac otkucao, na jeziku tržišta.</p>
        </div>
        <Filters />
      </div>

      <section className="panel">
        <h2>Dodaj upite</h2>
        <p className="sub">Jedan upit po redu. Primer: „Gde da kupim originalne Nike patike online u Srbiji?”</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"Najbolje online prodavnice odeće u Srbiji\nGde kupiti Guess torbu u Beogradu\nKoja prodavnica ima najveće popuste na brendiranu garderobu"} />
        <div className="filters" style={{ marginTop: 10 }}>
          <select value={mk} onChange={(e) => setMk(e.target.value)} aria-label="Tržište">
            {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <input type="text" placeholder="Tema (npr. patike)" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <button className="btn primary" onClick={add} disabled={busy || !text.trim()}>Dodaj {text.split("\n").filter((l) => l.trim()).length || ""} upita</button>
        </div>
      </section>

      <section className="panel">
        <h2>Rezultati po upitu</h2>
        <p className="sub">Polje pokazuje da li je vaš brend pomenut (i na kom mestu) u izabranom pokretanju. Klik vodi na odgovore.</p>
        {!shown.length ? <p className="muted">Još nema upita.</p> : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Upit</th><th>Tržište</th>
                  {providers.map((p) => <th key={p.id}><PV p={p.id} /></th>)}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                    <td style={{ maxWidth: 420 }}>
                      {p.text}
                      {p.topic && <div><span className="tag">{p.topic}</span></div>}
                    </td>
                    <td>{p.market}</td>
                    {providers.map((pv) => {
                      const c = cell.get(`${p.id}:${pv.id}`);
                      if (!c) return <td key={pv.id} className="faint">—</td>;
                      return (
                        <td key={pv.id} style={{ cursor: "pointer", minWidth: 120 }} onClick={() => nav(`/odgovori?prompt=${p.id}&provider=${pv.id}`)}>
                          {c.own_mentioned ? (
                            <span className="tag own">#{c.own_best_rank}, {c.own_mentioned}/{c.samples}</span>
                          ) : <span className="tag">nije pomenut</span>}
                          {c.competitors.length > 0 && <div className="small muted" style={{ marginTop: 2 }}>{c.competitors.slice(0, 3).join(", ")}{c.competitors.length > 3 ? ` +${c.competitors.length - 3}` : ""}</div>}
                        </td>
                      );
                    })}
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn ghost small" onClick={() => toggle(p)}>{p.active ? "Pauziraj" : "Uključi"}</button>
                      <button className="btn ghost small" onClick={() => remove(p)}>Obriši</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
