// Zajedničko za Feed X-ray i Agent Feed: preuzimanje (i .gz), parsiranje Google Merchant RSS-a, Supabase REST/Storage.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export function parseArgs(argv) {
  return Object.fromEntries(
    argv.reduce((a, v, i, all) => {
      if (v.startsWith("--")) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
      return a;
    }, []),
  );
}

/** Tekst feeda sa URL-a ili iz fajla; .gz (ili gzip sadržaj) se raspakuje. */
export async function loadText(src) {
  let buf;
  if (/^https?:/.test(src)) {
    const r = await fetch(src, { headers: { "user-agent": BROWSER_UA } });
    if (!r.ok) throw new Error(`Feed ${src}: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else buf = await readFile(src);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  return buf.toString("utf8");
}

export const decode = (s) =>
  s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();

/**
 * Parsira <item> elemente. Svaki artikal je objekat polje → vrednost (bez prefiksa g:);
 * additional_image_link ide u niz extra_images. order čuva redosled polja za ponovni ispis.
 */
export function parseItems(xml) {
  const items = [];
  const fieldNames = new Set();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = { extra_images: [], _order: [], _raw: m[0] };
    for (const f of m[1].matchAll(/<((?:g:)?[a-z_0-9]+)>([\s\S]*?)<\/\1>/g)) {
      const key = f[1].replace(/^g:/, "");
      const val = decode(f[2]);
      fieldNames.add(key);
      if (key === "additional_image_link") { if (val) it.extra_images.push(val); continue; }
      it[key] = val;
      it._order.push([f[1], key]);
    }
    items.push(it);
  }
  return { items, fieldNames };
}

export const cdata = (s) => `<![CDATA[${String(s ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;

/** Supabase REST + Storage sa service role ključem iz env-a. */
export function supabase() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Potrebni su SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY");
  const h = { apikey: key, authorization: `Bearer ${key}` };
  const ok = async (r, what) => {
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${await r.text()}`);
    return r;
  };
  return {
    url,
    async select(table, query = "select=*") {
      return (await ok(await fetch(`${url}/rest/v1/${table}?${query}`, { headers: h }), `čitanje ${table}`)).json();
    },
    async insert(table, row) {
      await ok(await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...h, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(row) }), `upis u ${table}`);
    },
    async update(table, match, patch) {
      await ok(await fetch(`${url}/rest/v1/${table}?${match}`, { method: "PATCH", headers: { ...h, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(patch) }), `izmena ${table}`);
    },
    /** upsert u serijama; conflict = kolone primarnog ključa */
    async upsert(table, rows, conflict) {
      for (let i = 0; i < rows.length; i += 1000) {
        await ok(await fetch(`${url}/rest/v1/${table}?on_conflict=${conflict}`, {
          method: "POST", headers: { ...h, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 1000)),
        }), `upsert ${table}`);
      }
    },
    async remove(table, match) {
      await ok(await fetch(`${url}/rest/v1/${table}?${match}`, { method: "DELETE", headers: { ...h, prefer: "return=minimal" } }), `brisanje iz ${table}`);
    },
    async upload(bucket, path, body, contentType) {
      await ok(await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
        method: "POST", headers: { ...h, "content-type": contentType, "x-upsert": "true", "cache-control": "max-age=300" }, body,
      }), `upload ${bucket}/${path}`);
    },
    async download(bucket, path) {
      const r = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, { headers: h });
      if (r.status === 400 || r.status === 404) return null;
      return Buffer.from(await (await ok(r, `download ${bucket}/${path}`)).arrayBuffer());
    },
    publicUrl: (bucket, path) => `${url}/storage/v1/object/public/${bucket}/${path}`,
  };
}

/** Veličine sa Magento proizvodne stranice (jsonConfig konfigurabilnog proizvoda). null = stranica bez konfiguracije. */
export function parseMagentoSizes(html) {
  const i = html.indexOf('"jsonConfig":');
  if (i < 0) return null;
  const j = html.indexOf("{", i);
  let depth = 0, k = j;
  for (; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}" && --depth === 0) break;
  }
  try {
    const cfg = JSON.parse(html.slice(j, k + 1));
    const size = Object.values(cfg.attributes ?? {}).find((a) => a.code === "size");
    return size ? size.options.map((o) => o.label) : [];
  } catch { return null; }
}
