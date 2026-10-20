import { useEffect, useState } from "react";
import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { AppProvider, useApp } from "./lib/ctx";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import Prompts from "./pages/Prompts";
import Responses from "./pages/Responses";
import Trace from "./pages/Trace";
import Sources from "./pages/Sources";
import Fanout from "./pages/Fanout";
import Runs from "./pages/Runs";
import Settings from "./pages/Settings";
import FeedXray from "./pages/FeedXray";
import Crossing from "./pages/Crossing";
import FeedCompare from "./pages/FeedCompare";

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <circle cx="8" cy="16" r="4" fill="var(--own)" />
      <circle cx="24" cy="8" r="3" fill="var(--faint)" />
      <circle cx="24" cy="24" r="3" fill="var(--cite)" />
      <path d="M11 15 21 9M11 17l10 6" stroke="var(--ink)" strokeWidth="2" />
    </svg>
  );
}

function Shell() {
  const { workspaces, ws, setWsId } = useApp();
  return (
    <div className="shell">
      <aside className="side">
        <div className="brandmark"><Mark /> AI Vidljivost</div>
        {workspaces.length > 0 && (
          <select aria-label="Klijent" value={ws?.id ?? ""} onChange={(e) => setWsId(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <nav className="nav">
          <NavLink to="/" end>Pregled</NavLink>
          <NavLink to="/odgovori">Odgovori i trag</NavLink>
          <NavLink to="/izvori">Izvori</NavLink>
          <NavLink to="/pretrage">Pretrage</NavLink>
          <NavLink to="/feed">Feed X-ray</NavLink>
          <NavLink to="/feed-poredjenje">Feed pre/posle</NavLink>
          <NavLink to="/ukrstanje">Ukrštanje</NavLink>
          <NavLink to="/upiti">Upiti</NavLink>
          <NavLink to="/pokretanja">Pokretanja</NavLink>
          <NavLink to="/podesavanja">Brendovi i klijenti</NavLink>
        </nav>
        <div className="foot">
          <button className="btn ghost small" onClick={() => supabase.auth.signOut()}>Odjavi se</button>
        </div>
      </aside>
      <main className="main">
        {!ws ? (
          <Settings firstRun />
        ) : (
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/odgovori" element={<Responses />} />
            <Route path="/odgovori/:id" element={<Trace />} />
            <Route path="/izvori" element={<Sources />} />
            <Route path="/pretrage" element={<Fanout />} />
            <Route path="/feed" element={<FeedXray />} />
            <Route path="/feed-poredjenje" element={<FeedCompare />} />
            <Route path="/ukrstanje" element={<Crossing />} />
            <Route path="/upiti" element={<Prompts />} />
            <Route path="/pokretanja" element={<Runs />} />
            <Route path="/podesavanja" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (session === undefined) return null;
  if (!session) return <Login />;
  return (
    <HashRouter>
      <AppProvider>
        <Shell />
      </AppProvider>
    </HashRouter>
  );
}
