import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { Brand, Run, supabase, Workspace } from "./supabase";

interface Ctx {
  workspaces: Workspace[];
  ws: Workspace | null;
  setWsId: (id: string) => void;
  brands: Brand[];
  runs: Run[];
  runId: string | null;          // null = sva pokretanja
  setRunId: (id: string | null) => void;
  market: string | null;
  setMarket: (m: string | null) => void;
  reload: () => Promise<void>;
  reloadRuns: () => Promise<void>;
}

const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

const LS = "aiv.ws";
const read = () => { try { return localStorage.getItem(LS); } catch { return null; } };
const write = (v: string) => { try { localStorage.setItem(LS, v); } catch { /* */ } };

export function AppProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsIdState] = useState<string | null>(read());
  const [brands, setBrands] = useState<Brand[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runSel, setRunSel] = useState<string>(""); // "" = još nije izabrano, "all" = sva
  const [market, setMarket] = useState<string | null>(null);

  const setWsId = (id: string) => { setWsIdState(id); write(id); setRunSel(""); };

  const reload = useCallback(async () => {
    const { data } = await supabase.from("workspaces").select("id,name").order("created_at");
    setWorkspaces(data ?? []);
    if (data?.length && !data.find((w) => w.id === wsId)) setWsId(data[0].id);
  }, [wsId]);

  const reloadRuns = useCallback(async () => {
    if (!wsId) return;
    const [{ data: b }, { data: r }] = await Promise.all([
      supabase.from("brands").select("*").eq("workspace_id", wsId).order("is_own", { ascending: false }).order("name"),
      supabase.from("runs").select("*").eq("workspace_id", wsId).order("created_at", { ascending: false }).limit(50),
    ]);
    setBrands(b ?? []);
    setRuns(r ?? []);
  }, [wsId]);

  useEffect(() => { reload(); }, []); // eslint-disable-line
  useEffect(() => { reloadRuns(); }, [reloadRuns]);

  // podrazumevano: poslednje završeno pokretanje
  useEffect(() => {
    if (runSel === "" && runs.length) {
      const done = runs.find((r) => r.status === "done") ?? runs[0];
      setRunSel(done.id);
    }
  }, [runs]); // eslint-disable-line

  const runId = runSel === "" || runSel === "all" ? null : runSel;
  const setRunId = (id: string | null) => setRunSel(id ?? "all");
  const ws = workspaces.find((w) => w.id === wsId) ?? null;
  return (
    <C.Provider value={{ workspaces, ws, setWsId, brands, runs, runId, setRunId, market, setMarket, reload, reloadRuns }}>
      {children}
    </C.Provider>
  );
}
