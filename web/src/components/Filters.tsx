import { useApp } from "../lib/ctx";
import { fmtDate, MARKETS, pLabel, PROVIDERS } from "../lib/supabase";

export function Filters({ provider, setProvider }: { provider?: string | null; setProvider?: (p: string | null) => void }) {
  const { runs, runId, setRunId, market, setMarket } = useApp();
  return (
    <div className="filters">
      <select aria-label="Pokretanje" value={runId ?? "all"} onChange={(e) => setRunId(e.target.value === "all" ? null : e.target.value)}>
        <option value="all">Sva pokretanja</option>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {fmtDate(r.created_at)}: {r.providers.map(pLabel).join(", ")}{r.status === "running" ? " (u toku)" : ""}
          </option>
        ))}
      </select>
      <select aria-label="Tržište" value={market ?? ""} onChange={(e) => setMarket(e.target.value || null)}>
        <option value="">Sva tržišta</option>
        {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {setProvider && (
        <select aria-label="AI sistem" value={provider ?? ""} onChange={(e) => setProvider(e.target.value || null)}>
          <option value="">Svi AI sistemi</option>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      )}
    </div>
  );
}

export function PV({ p }: { p: string }) {
  const c = PROVIDERS.find((x) => x.id === p)?.color;
  return <span className="pv" style={{ ["--c" as any]: c }}>{pLabel(p)}</span>;
}

export function NoData({ children }: { children?: React.ReactNode }) {
  return <div className="empty">{children ?? "Još nema podataka za ovaj izbor. Pokrenite merenje na stranici Pokretanja."}</div>;
}
