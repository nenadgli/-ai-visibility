import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

export type Provider = "chatgpt" | "claude" | "gemini" | "perplexity" | "google_aio";

export const PROVIDERS: { id: Provider; label: string; color: string }[] = [
  { id: "chatgpt", label: "ChatGPT", color: "#3b9c84" },
  { id: "claude", label: "Claude", color: "#a8643c" },
  { id: "gemini", label: "Gemini", color: "#4a73d8" },
  { id: "perplexity", label: "Perplexity", color: "#2a8a9a" },
  { id: "google_aio", label: "Google AI Overviews", color: "#c5482f" },
];
export const pLabel = (p: string) => PROVIDERS.find((x) => x.id === p)?.label ?? p;
export const pColor = (p: string) => PROVIDERS.find((x) => x.id === p)?.color ?? "#999";

export const MARKETS = [
  { id: "RS", label: "Srbija" },
  { id: "HR", label: "Hrvatska" },
  { id: "BA", label: "BiH" },
  { id: "EN", label: "Engleski (US)" },
];

export interface Workspace { id: string; name: string }
export interface Brand { id: string; workspace_id: string; name: string; aliases: string[]; domains: string[]; is_own: boolean; color: string | null }
export interface Prompt { id: string; workspace_id: string; text: string; market: string; topic: string | null; intent: string | null; active: boolean; created_at: string }
export interface Run { id: string; workspace_id: string; providers: string[]; samples: number; status: string; note: string | null; created_at: string; finished_at: string | null }

export async function api<T = any>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("api", { body });
  if (error) {
    // izvući poruku iz tela greške
    let msg = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx?.json) msg = (await ctx.json()).error ?? msg;
    } catch { /* */ }
    throw new Error(msg);
  }
  return data as T;
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export const fmtDate = (s: string) =>
  new Date(s).toLocaleString("sr-Latn-RS", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
