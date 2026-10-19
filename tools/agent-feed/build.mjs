#!/usr/bin/env node
// Agent Feed: od klijentovog Magento feeda pravi ispravljen feed za Google, Metu i AI agente.
//
// Dva izlaza:
//   google-supplemental.xml.gz  dopunski feed (samo g:id + ispravke): google_product_category, title,
//                               product_type, age_group. Klijentov feed ostaje glavni → nula rizika.
//   google.xml.gz               pun feed: sve ispravke + jedan red po veličini (item_group_id) za proizvode
//                               čije su veličine u kešu (čitaju se sa proizvodnih stranica, malo po malo).
// Uz to puni tabelu catalog_products (katalog za ukrštanje sa AI odgovorima, migracija 006).
//
//   Lokalno:  node tools/agent-feed/build.mjs --source <url|fajl> [--site <url>] --out-dir <dir> [--crawl 0]
//   Sve:      node tools/agent-feed/build.mjs --all    (tabela agent_feeds → Supabase Storage, bucket "feeds")
//
// Zaštita: ako ulaz ima 0 proizvoda ili manje od 70% prošlog broja, ništa se ne objavljuje
// (ostaje poslednji ispravan feed), greška se upisuje u agent_feeds.last_error i proces vraća 1.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BROWSER_UA, cdata, loadText, parseArgs, parseItems, parseMagentoSizes, supabase } from "../lib/feed.mjs";
import { LEAF_TO_GOOGLE, TOP_TO_AGE_GROUP } from "./taxonomy.mjs";

const args = parseArgs(process.argv.slice(2));
const MIN_RATIO = 0.7;

// ---------------------------------------------------------------- --all: svaki feed u svom procesu
if (args.all) {
  const db = supabase();
  const rows = await db.select("agent_feeds", "select=id,name&active=eq.true");
  let failed = 0;
  for (const f of rows) {
    console.error(`— ${f.name}`);
    try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--id", f.id], { stdio: "inherit" }); } catch { failed++; }
  }
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- konfiguracija
let cfg, db = null;
if (args.id) {
  db = supabase();
  [cfg] = await db.select("agent_feeds", `select=*&id=eq.${args.id}`);
  if (!cfg) throw new Error(`agent_feeds ${args.id} ne postoji`);
} else if (args.source) {
  cfg = { source_url: args.source, site_url: args.site ?? null, token: "local", last_items: null, config: { size_crawl_per_run: Number(args.crawl ?? 0) } };
} else {
  console.error("Upotreba: build.mjs --source <url|fajl> [--site <url>] --out-dir <dir> [--crawl N]  |  --id <agent_feed>  |  --all");
  process.exit(1);
}
const crawlBudget = Number(cfg.config?.size_crawl_per_run ?? 0);

async function fail(msg) {
  console.error("NIJE OBJAVLJENO:", msg);
  if (db) await db.update("agent_feeds", `id=eq.${cfg.id}`, { last_error: msg, last_checked_at: new Date().toISOString() });
  process.exit(1);
}

// ---------------------------------------------------------------- ulaz + zaštita
let parsed;
try { parsed = parseItems(await loadText(cfg.source_url)); } catch (e) { await fail(`ulazni feed: ${e.message}`); }
const items = parsed.items;
if (!items.length) await fail("ulazni feed nema nijedan proizvod");
if (cfg.last_items && items.length < cfg.last_items * MIN_RATIO) {
  await fail(`ulazni feed ima ${items.length} proizvoda, prošli put ${cfg.last_items} (pad veći od ${Math.round((1 - MIN_RATIO) * 100)}%)`);
}

// ---------------------------------------------------------------- ispravke po proizvodu
const stats = { products: items.length, gpc_mapped: 0, unmapped: {}, titles_fixed: 0, models_added: 0, cats_fixed: 0, kids: 0 };
const norm = (s) => (s || "").toLowerCase().replace(/[čć]/g, "c").replace(/ž/g, "z").replace(/š/g, "s").replace(/đ/g, "d")
  .replace(/['’]/g, "").replace(/[^a-z0-9&]+/g, " ").trim();

function fixProductType(pt) {
  // Magento ponekad spoji dve putanje bez razmaka: "Muškarci > Obuća > CipeleDeca > Devojčice > Obuća"
  const m = /^(.*?[a-zčćžšđ])([A-ZČĆŽŠĐ].*>.*)$/.exec(pt || "");
  return m && m[1].includes(">") ? m[1] : pt;
}
function fixTitle(title, brand) {
  let t = (title || "").replace(/\s+/g, " ").replace(/\s*–\s*/g, " - ").trim();
  if (brand) {
    // odsečen brend na kraju: "… - Timb" → "… - Timberland"
    const m = / - ([^-]+)$/.exec(t);
    if (m && m[1].length < brand.length && brand.toLowerCase().startsWith(m[1].toLowerCase())) t = t.slice(0, m.index) + " - " + brand;
    const first = brand.toLowerCase().split(/[\s&']/)[0];
    if (!t.toLowerCase().includes(first) && t.length + brand.length + 3 <= 150) t = `${t} - ${brand}`;
  }
  return t;
}

// Naziv modela iz opisa ("Steve Madden Possession-E ženske patike…" → "Possession-E") kad ga naziv ne pominje.
// AI i Google traže po modelu ("Steve Madden Possession"), a Magento nazivi su opisni ("Ženske patike sa debelim đonom").
const MODEL_STOP = new Set(["i", "sa", "za", "od", "u", "na", "bez", "logo", "logom", "original", "model"]);
function modelFromDescription(d) {
  const desc = (d.description || "").trim(), brand = (d.brand || "").trim();
  if (!brand || !desc) return null;
  const words = desc.split(/\s+/), bw = brand.split(/\s+/).length;
  if (norm(words.slice(0, bw).join(" ")) !== norm(brand)) return null;
  const out = [];
  for (const w of words.slice(bw)) {
    const c = w.replace(/[,.;:®™]+$/, "");
    if (!c || MODEL_STOP.has(c.toLowerCase()) || !/^[A-Z0-9ČĆŽŠĐ]/.test(c)) break;
    out.push(c);
    if (/[,.;:]$/.test(w) || out.length >= 4) break;
  }
  if (out.some((p) => p.length > 12)) return null; // dugačke šifre nisu model
  // izbaci delove koji su već u nazivu, godine kolekcije ("2019") i pakovanja ("3Pack")
  const tw = new Set(norm(d._title).split(" "));
  const parts = out.filter((p) => !norm(p).split(" ").every((x) => tw.has(x))
    && !/^(19|20)\d\d$/.test(p) && !/^\d+-?pack$/i.test(p) && !p.includes(".") && !/^\d+u\d+$/i.test(p) && !/^\d{3}[A-Z]{2,3}$/.test(p));
  if (!parts.length) return null;
  // VELIKA SLOVA → Velika (osim rimskih brojeva i oznaka sa ciframa)
  return parts.map((p) => p.split("-").map((x) => (/^[A-ZČĆŽŠĐ]{3,}$/.test(x) && !/^[IVX]+$/.test(x) ? x[0] + x.slice(1).toLowerCase() : x)).join("-")).join(" ");
}
function withModel(title, brand, model) {
  const nb = norm(brand);
  let rest = title.split(/\s+-\s+/).filter((p) => norm(p) !== nb).join(" - ");
  const re = new RegExp(`(^|\\s)${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "i");
  rest = rest.replace(re, " ").replace(/\s{2,}/g, " ").replace(/^[\s-]+|[\s-]+$/g, "");
  const t = rest ? `${brand} ${model} - ${rest}` : `${brand} ${model}`;
  return t.length <= 150 ? t : title;
}

for (const d of items) {
  const pt = fixProductType(d.product_type);
  if (pt !== d.product_type) stats.cats_fixed++;
  d._pt = pt;
  const parts = (pt || "").split(" > ").map((x) => x.trim().toLowerCase());
  const leaf = parts[parts.length - 1];
  d._gpc = d.google_product_category || LEAF_TO_GOOGLE[leaf] || LEAF_TO_GOOGLE[parts[parts.length - 2]] || "";
  if (d._gpc) stats.gpc_mapped++;
  else stats.unmapped[pt || "(prazno)"] = (stats.unmapped[pt || "(prazno)"] ?? 0) + 1;
  d._age = TOP_TO_AGE_GROUP[parts[0]] ?? "";
  if (d._age === "kids") stats.kids++;
  d._title = fixTitle(d.title, d.brand);
  const model = modelFromDescription(d);
  if (model) { d._title = withModel(d._title, d.brand, model); stats.models_added++; }
  if (d._title !== d.title) stats.titles_fixed++;
  d._images = d.extra_images.filter((u) => u && u !== d.image_link).slice(0, 10);
}

// ---------------------------------------------------------------- keš veličina (proizvodne stranice)
const cachePath = `${cfg.token}/sizes.json`;
let cache = {};
if (db) { const b = await db.download("feed-cache", cachePath); if (b) cache = JSON.parse(b.toString("utf8")); }
else if (args["cache"]) { try { cache = JSON.parse(await readFile(args["cache"], "utf8")); } catch { /* nov keš */ } }
const ids = new Set(items.map((d) => d.id));
for (const k of Object.keys(cache)) if (!ids.has(k)) delete cache[k];

const crawl = { budget: crawlBudget, fetched: 0, failed: 0 };
if (crawlBudget > 0) {
  // prvo proizvodi bez podataka, zatim najstariji
  const queue = items.filter((d) => d.product_type_id !== "simple" && d.link)
    .sort((a, b) => (cache[a.id]?.t ?? 0) - (cache[b.id]?.t ?? 0)).slice(0, crawlBudget);
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift();
      try {
        const r = await fetch(d.link, { headers: { "user-agent": BROWSER_UA } });
        if (r.status === 404) { delete cache[d.id]; continue; }
        if (!r.ok) { crawl.failed++; continue; }
        const sizes = parseMagentoSizes(await r.text());
        cache[d.id] = { s: sizes ?? [], t: Date.now() };
        crawl.fetched++;
      } catch { crawl.failed++; }
      await new Promise((ok) => setTimeout(ok, 250)); // pažljivo prema sajtu klijenta
    }
  };
  await Promise.all([worker(), worker()]);
  console.error(`Keš veličina: pročitano ${crawl.fetched}, neuspešno ${crawl.failed}, u kešu ${Object.keys(cache).length}/${items.length}`);
}

// ---------------------------------------------------------------- ispis
const HEAD = (title) => `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n<title>${cdata(title)}</title>\n`;
const FOOT = "</channel>\n</rss>\n";
const tag = (name, v) => (v === undefined || v === null || v === "" ? "" : `<${name}>${cdata(v)}</${name}>`);

// polja koja Google ne poznaje ili ih ispisujemo posebno
const SKIP = new Set(["id", "title", "product_type", "google_product_category", "size", "item_group_id", "identify", "search_image", "currency", "product_type_id", "ingredients", "skin_type", "color_shade"]);
const PLAIN = new Set(["title", "link", "description"]);

function itemXml(d, variant) {
  const out = ["<item>"];
  out.push(tag("g:id", variant ? `${d.id}-${variant.replace(/[^\w.-]+/g, "_")}` : d.id));
  out.push(tag("title", d._title));
  for (const [, key] of d._order) {
    if (SKIP.has(key)) continue;
    out.push(tag(PLAIN.has(key) ? key : `g:${key}`, d[key]));
  }
  for (const u of d._images) out.push(tag("g:additional_image_link", u));
  out.push(tag("g:product_type", d._pt));
  out.push(tag("g:google_product_category", d._gpc));
  if (d._age) out.push(tag("g:age_group", d._age));
  if (variant) { out.push(tag("g:item_group_id", d.id)); out.push(tag("g:size", variant)); }
  else out.push(tag("g:size", d.size));
  out.push("</item>\n");
  return out.join("");
}

let rows = 0, variantProducts = 0;
const full = [HEAD("Agent Feed")];
for (const d of items) {
  const sizes = cache[d.id]?.s ?? [];
  if (sizes.length > 1) {
    variantProducts++;
    for (const z of sizes) { full.push(itemXml(d, z)); rows++; }
  } else { full.push(itemXml(d, null)); rows++; }
}
full.push(FOOT);

const supp = [HEAD("Agent Feed – dopunski")];
for (const d of items) {
  supp.push(`<item>${tag("g:id", d.id)}${tag("title", d._title)}${tag("g:product_type", d._pt)}${tag("g:google_product_category", d._gpc)}${tag("g:age_group", d._age)}</item>\n`);
}
supp.push(FOOT);

const files = {
  "google.xml.gz": gzipSync(full.join(""), { level: 9 }),
  "google-supplemental.xml.gz": gzipSync(supp.join(""), { level: 9 }),
};
Object.assign(stats, { rows, variant_products: variantProducts, sizes_cached: Object.keys(cache).length, crawl, unmapped_count: items.length - stats.gpc_mapped });
const top = Object.entries(stats.unmapped).sort((a, b) => b[1] - a[1]).slice(0, 10);
stats.unmapped = Object.fromEntries(top);
stats.bytes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length]));

console.error(`Proizvoda ${items.length} · redova ${rows} (${variantProducts} sa veličinama) · Google kategorija ${stats.gpc_mapped}/${items.length} · ispravljenih naziva ${stats.titles_fixed} (model dodat ${stats.models_added}) · kategorija ${stats.cats_fixed}`);
if (top.length) console.error("Bez mapiranja:", top.map(([k, v]) => `${k} (${v})`).join("; "));

if (db) {
  for (const [name, body] of Object.entries(files)) await db.upload("feeds", `${cfg.token}/${name}`, body, "application/gzip");
  await db.upload("feed-cache", cachePath, Buffer.from(JSON.stringify(cache)), "application/json");
  // katalog za ukrštanje sa AI odgovorima: upsert svih proizvoda, pa brisanje onih kojih više nema.
  // Greška ovde ne poništava objavljen feed; beleži se u stats.catalog_error.
  try {
    const runAt = new Date().toISOString();
    const price = (v) => { const m = /^[\d.]+/.exec(v ?? ""); return m ? Number(m[0]) : null; };
    await db.upsert("catalog_products", items.map((d) => ({
      workspace_id: cfg.workspace_id, product_id: d.id, title: d._title, orig_title: d.title, description: (d.description || "").slice(0, 600),
      brand: d.brand || null, product_type: d._pt || null, link: d.link || null, price: price(d.price), sale_price: price(d.sale_price),
      sizes: cache[d.id]?.s ?? (d.size ? [d.size] : []), updated_at: runAt,
    })), "workspace_id,product_id");
    await db.remove("catalog_products", `workspace_id=eq.${cfg.workspace_id}&updated_at=lt.${encodeURIComponent(runAt)}`);
  } catch (e) { stats.catalog_error = e.message; console.error("Katalog nije upisan:", e.message); }
  const now = new Date().toISOString();
  await db.update("agent_feeds", `id=eq.${cfg.id}`, { last_built_at: now, last_checked_at: now, last_items: items.length, last_error: null, stats });
  console.error("Objavljeno:", Object.keys(files).map((f) => db.publicUrl("feeds", `${cfg.token}/${f}`)).join("  "));
} else {
  const dir = args["out-dir"] ?? ".";
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(`${dir}/${name}`, body);
  if (args["cache"]) await writeFile(args["cache"], JSON.stringify(cache));
  await writeFile(`${dir}/stats.json`, JSON.stringify(stats, null, 2));
  console.error(`Upisano u ${dir}`);
}
