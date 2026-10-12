import { FormEvent, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message === "Invalid login credentials" ? "Pogrešan email ili lozinka." : error.message);
    setBusy(false);
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="panel">
        <h1>AI Vidljivost</h1>
        <p className="muted" style={{ marginBottom: 8 }}>Kako ChatGPT, Claude, Gemini i Perplexity odgovaraju o vašim brendovima — i odakle im informacije.</p>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        <input type="password" placeholder="Lozinka" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        {err && <p className="err small">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? "Prijavljivanje…" : "Prijavi se"}</button>
      </form>
    </div>
  );
}
