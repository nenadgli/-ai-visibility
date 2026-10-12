import { useState } from "react";
import { useApp } from "../lib/ctx";
import { Brand, supabase } from "../lib/supabase";

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const dom = (s: string) => list(s).map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""));

function BrandRow({ b, onChange }: { b: Brand; onChange: () => void }) {
  const [name, setName] = useState(b.name);
  const [aliases, setAliases] = useState(b.aliases.join(", "));
  const [domains, setDomains] = useState(b.domains.join(", "));
  const dirty = name !== b.name || aliases !== b.aliases.join(", ") || domains !== b.domains.join(", ");
  async function save() {
    await supabase.from("brands").update({ name, aliases: list(aliases), domains: dom(domains) }).eq("id", b.id);
    onChange();
  }
  async function setOwn() {
    await supabase.from("brands").update({ is_own: false }).eq("workspace_id", b.workspace_id);
    await supabase.from("brands").update({ is_own: true }).eq("id", b.id);
    onChange();
  }
  async function remove() {
    if (!confirm(`Obrisati brend ${b.name}?`)) return;
    await supabase.from("brands").delete().eq("id", b.id);
    onChange();
  }
  return (
    <tr className={b.is_own ? "own" : ""}>
      <td><input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Naziv" /></td>
      <td><input type="text" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="F&F, Fashion and Friends" aria-label="Drugi nazivi" style={{ width: "100%" }} /></td>
      <td><input type="text" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="fashionandfriends.com" aria-label="Domeni" style={{ width: "100%" }} /></td>
      <td style={{ whiteSpace: "nowrap" }}>
        {dirty && <button className="btn primary small" onClick={save}>Sačuvaj</button>}
        {b.is_own ? <span className="tag own">vaš brend</span> : <button className="btn ghost small" onClick={setOwn}>Ovo je naš brend</button>}
        <button className="btn ghost small" onClick={remove}>Obriši</button>
      </td>
    </tr>
  );
}

export default function Settings({ firstRun }: { firstRun?: boolean }) {
  const { ws, brands, reload, reloadRuns, setWsId } = useApp();
  const [wsName, setWsName] = useState("");
  const [nb, setNb] = useState({ name: "", aliases: "", domains: "" });

  async function createWs() {
    if (!wsName.trim()) return;
    const { data } = await supabase.from("workspaces").insert({ name: wsName.trim() }).select().single();
    setWsName("");
    await reload();
    if (data) setWsId(data.id);
  }
  async function addBrand() {
    if (!ws || !nb.name.trim()) return;
    await supabase.from("brands").insert({ workspace_id: ws.id, name: nb.name.trim(), aliases: list(nb.aliases), domains: dom(nb.domains), is_own: brands.length === 0 });
    setNb({ name: "", aliases: "", domains: "" });
    reloadRuns();
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{firstRun ? "Dodajte prvog klijenta" : "Brendovi i klijenti"}</h1>
          <p>{firstRun ? "Klijent je skup brendova (vaš + konkurenti) i upita koje pratite." : "Drugi nazivi i domeni pomažu da se brend prepozna i kad ga AI napiše drugačije ili samo citira njegov sajt."}</p>
        </div>
      </div>

      {!firstRun && ws && (
        <section className="panel">
          <h2>Brendovi za {ws.name}</h2>
          <p className="sub">Padeži se prepoznaju sami (Zara, Zare, Zari). Posle izmena pokrenite „Ponovo prepoznaj brendove” na stranici Pokretanja.</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Naziv</th><th>Drugi nazivi (zarezom)</th><th>Domeni (zarezom)</th><th></th></tr></thead>
              <tbody>
                {brands.map((b) => <BrandRow key={b.id + b.name + b.is_own} b={b} onChange={reloadRuns} />)}
                <tr>
                  <td><input type="text" placeholder="Novi brend" value={nb.name} onChange={(e) => setNb({ ...nb, name: e.target.value })} /></td>
                  <td><input type="text" placeholder="Drugi nazivi" value={nb.aliases} onChange={(e) => setNb({ ...nb, aliases: e.target.value })} style={{ width: "100%" }} /></td>
                  <td><input type="text" placeholder="domen.rs" value={nb.domains} onChange={(e) => setNb({ ...nb, domains: e.target.value })} style={{ width: "100%" }} /></td>
                  <td><button className="btn" onClick={addBrand} disabled={!nb.name.trim()}>Dodaj brend</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Novi klijent</h2>
        <div className="filters" style={{ marginTop: 8 }}>
          <input type="text" placeholder="Naziv klijenta" value={wsName} onChange={(e) => setWsName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createWs()} />
          <button className="btn primary" onClick={createWs} disabled={!wsName.trim()}>Dodaj klijenta</button>
        </div>
      </section>
    </>
  );
}
