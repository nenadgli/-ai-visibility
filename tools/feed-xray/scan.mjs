#!/usr/bin/env node
// Feed X-ray: čita Google Merchant (RSS 2.0) feed, meri kvalitet podataka i strukturu asortimana,
// proverava uzorak proizvodnih stranica (veličine na sajtu vs. feed) i pristup AI agenata.
//
//   node tools/feed-xray/scan.mjs --feed <url|putanja> --site <https://sajt/> [--sample 30] [--out snapshot.json]
//   Sa --push i env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + --feed-id upisuje snimak u feed_snapshots.
//
// Bez zavisnosti (Node 22+). Feed od ~60 MB se obradi za par sekundi.
// Iza proksija: NODE_USE_ENV_PROXY=1 (Node 22.21+) da fetch koristi HTTPS_PROXY.

import { readFile, writeFile } from "node:fs/promises";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => {
    if (v.startsWith("--")) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return a;
  }, []),
);
if (!args.feed) {
  console.error("Upotreba: scan.mjs --feed <url|putanja> [--site <url>] [--sample 30] [--out file.json] [--push --feed-id <uuid>]");
  process.exit(1);
}
const SAMPLE = Number(args.sample ?? 30);
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// ---------------------------------------------------------------- učitavanje i parsiranje
const xml = /^https?:/.test(args.feed)
  ? await (await fetch(args.feed, { headers: { "user-agent": BROWSER_UA } })).text()
  : await readFile(args.feed, "utf8");

const decode = (s) =>
  s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();

const items = [];
const fieldNames = new Set();
for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
  const it = { extra_images: [] };
  for (const f of m[1].matchAll(/<((?:g:)?[a-z_0-9]+)>([\s\S]*?)<\/\1>/g)) {
    const key = f[1].replace(/^g:/, "");
    const val = decode(f[2]);
    fieldNames.add(key);
    if (key === "additional_image_link") { if (val) it.extra_images.push(val); }
    else it[key] = val;
  }
  items.push(it);
}
const N = items.length;
if (!N) { console.error("Feed nema <item> elemenata."); process.exit(1); }

const num = (s) => { const m = /^[\d.]+/.exec(s ?? ""); return m ? parseFloat(m[0]) : null; };
for (const d of items) {
  d._p = num(d.price);
  d._s = num(d.sale_price);
  d._eff = d._s ?? d._p ?? 0;
  d._disc = d._s && d._p ? 1 - d._s / d._p : 0;
}

// ---------------------------------------------------------------- pomoćne
const pct = (a, b = N) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ex = (d) => ({ id: d.id, title: d.title, link: d.link });
const groupBy = (key) => {
  const m = new Map();
  for (const d of items) { const k = d[key] || "(prazno)"; (m.get(k) ?? m.set(k, []).get(k)).push(d); }
  return m;
};
const firstWord = (s) => (s || "").toLowerCase().split(/[\s&']/)[0];
const label = (k) => items.filter((d) => d[k]).length;

// ---------------------------------------------------------------- provere kvaliteta
// severity: critical | high | medium | low; weight = koliko poena skida kad je pogođeno 100% artikala
const W = { critical: 25, high: 12, medium: 6, low: 2 };
const checks = [];
function check(id, severity, title, why, fix, hit, opts = {}) {
  const affected = opts.affected ?? items.filter(hit);
  const n = opts.count ?? affected.length;
  const base = opts.base ?? N;
  checks.push({
    id, severity, title, why, fix,
    affected: n, base, share: pct(n, base),
    examples: (opts.examples ?? affected.slice(0, 5).map(ex)),
    note: opts.note ?? null,
  });
}
const has = (k) => fieldNames.has(k);
const isCatJoined = (pt) => /[a-zčćžšđ][A-ZČĆŽŠĐ]/.test(pt || "");

check("gpc", "critical", "Google kategorija je prazna",
  "Bez google_product_category Google i AI agenti sami pogađaju šta je proizvod. Lošije se prikazuje u Shoppingu i u AI preporukama.",
  "Jednom mapirati interne kategorije (product_type) na Google taksonomiju i dodavati je u feed.",
  (d) => !d.google_product_category);
check("gtin", "high", "Nema GTIN/EAN koda",
  "Bez GTIN-a agent ne može da upari proizvod sa istim proizvodom kod drugih prodavaca i da ga uporedi.",
  "Izvući EAN iz ERP-a ili Magento atributa i dodati g:gtin.",
  (d) => !d.gtin, { note: has("gtin") ? null : "Polje g:gtin ne postoji u feedu." });
const cut = items.filter((d) => (d.title || "").length === 50 && !/[.)!]$/.test(d.title));
check("title_cut", "high", "Naziv odsečen na 50 znakova",
  "Odsečen naziv („… - Timb“) gubi ime brenda baš tamo gde je najvažnije. Isti naziv se vidi i na sajtu i u schemi.",
  "Ukloniti limit od 50 znakova u Magento šablonu naziva / izvozu.",
  null, { affected: cut });
check("title_brand", "medium", "Naziv bez imena brenda",
  "Agenti i Google traže „brend + tip proizvoda“. Bez brenda u nazivu proizvod se teže pronalazi.",
  "Pravilo za naziv: Brend + tip + ključni atribut + boja.",
  (d) => d.brand && !(d.title || "").toLowerCase().includes(firstWord(d.brand)));
check("cat_joined", "high", "Pokvarena kategorija (spojene dve putanje)",
  "Magento je spojio dve kategorije bez razmaka, npr. „…CipeleDeca > …“. Takva kategorija nikome ništa ne znači.",
  "Ispraviti izvoz product_type: uzeti jednu (glavnu) putanju kategorije.",
  (d) => isCatJoined(d.product_type));
check("color", "medium", "Nedostaje boja",
  "Boja je jedan od najčešćih filtera u modnim upitima („crna haljina“).",
  "Popuniti atribut boje; „Jeans“ i „Print“ zameniti stvarnom bojom + pattern.",
  (d) => !d.color);
check("desc_short", "medium", "Kratak opis (< 80 znakova)",
  "Kratak opis ne daje agentu materijal, kroj ni priliku za nošenje, pa ne može da odgovori na detaljna pitanja.",
  "Obogatiti opise (materijal, kroj, sastav, prilika) — može poluautomatski uz AI.",
  (d) => (d.description || "").length < 80);
check("gender", "low", "Nedostaje pol",
  "Pol je obavezan za odeću i obuću u Google Merchantu.",
  "Popuniti g:gender.",
  (d) => !d.gender);
check("dbl_space", "low", "Dupli razmak ili nepravilna crtica u nazivu",
  "Sitnica, ali isti brend zapisan na više načina smanjuje poverenje u katalog.",
  "Normalizovati naziv pri izvozu.",
  (d) => /\s{2,}|–/.test(d.title || ""));
const weights = new Set(items.map((d) => d.shipping_weight));
check("weight", "low", "Ista težina za sve artikle",
  "Težina se koristi za obračun dostave; ista vrednost za sve je podrazumevana, a ne stvarna.",
  "Uneti stvarne težine po kategoriji ili izbaciti polje.",
  null, { affected: weights.size === 1 ? items : [], note: weights.size === 1 ? `Svuda: ${[...weights][0]}` : null });
check("img_dup", "low", "Prva dodatna slika = glavna slika",
  "Dupla slika zauzima mesto koje bi mogla da ima druga fotografija proizvoda.",
  "Iz additional_image_link izbaciti glavnu sliku.",
  (d) => d.extra_images.includes(d.image_link));

// ---------------------------------------------------------------- uzorak proizvodnih stranica: veličine
const configurable = items.filter((d) => d.product_type_id === "configurable");
const variantCheck = { sampled: 0, fetched: 0, more_on_site: 0, avg_site_sizes: 0, examples: [] };
if (args.site !== undefined && SAMPLE > 0 && configurable.length) {
  const step = Math.max(1, Math.floor(configurable.length / SAMPLE));
  const sample = configurable.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  variantCheck.sampled = sample.length;
  const siteSizes = [];
  for (const d of sample) {
    try {
      const h = await (await fetch(d.link, { headers: { "user-agent": BROWSER_UA } })).text();
      const sizes = parseSizes(h);
      if (!sizes) continue;
      variantCheck.fetched++;
      siteSizes.push(sizes.length);
      if (sizes.length > 1) {
        variantCheck.more_on_site++;
        if (variantCheck.examples.length < 5) variantCheck.examples.push({ ...ex(d), feed_size: d.size, site_sizes: sizes });
      }
    } catch { /* preskoči */ }
  }
  variantCheck.avg_site_sizes = Math.round(avg(siteSizes) * 10) / 10;
}
if (variantCheck.fetched) {
  const share = variantCheck.fetched ? variantCheck.more_on_site / variantCheck.fetched : 0;
  checks.push({
    id: "variants", severity: "critical", title: "Feed prikazuje samo jednu veličinu po proizvodu",
    why: `Na sajtu proizvod ima više veličina (u proseku ${variantCheck.avg_site_sizes}), a feed navodi samo jednu i nema item_group_id. Agent zato misli da postoji samo jedan broj i na pitanje „imate li 42?“ odgovara pogrešno.`,
    fix: "Izvoziti jedan red po varijanti (veličini) sa zajedničkim item_group_id.",
    affected: Math.round(share * configurable.length), base: N, share: pct(Math.round(share * configurable.length)),
    examples: variantCheck.examples,
    note: `Procena iz uzorka od ${variantCheck.fetched} proizvodnih stranica (${variantCheck.more_on_site} ima više veličina nego feed).`,
  });
}
function parseSizes(html) {
  const i = html.indexOf('"jsonConfig":');
  if (i < 0) return null;
  let j = html.indexOf("{", i), depth = 0, k = j;
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

// ---------------------------------------------------------------- pristup AI agenata
const BOTS = [
  ["OAI-SearchBot", "ChatGPT pretraga i shopping", "search", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot"],
  ["ChatGPT-User", "ChatGPT otvara link za korisnika", "agent", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"],
  ["GPTBot", "OpenAI trening", "training", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"],
  ["ClaudeBot", "Anthropic crawler", "training", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com"],
  ["Claude-User", "Claude otvara link za korisnika", "agent", "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)"],
  ["PerplexityBot", "Perplexity pretraga", "search", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"],
  ["Perplexity-User", "Perplexity otvara link za korisnika", "agent", "Mozilla/5.0 (compatible; Perplexity-User/1.0)"],
  ["Googlebot", "Google pretraga i AI Overviews", "search", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
  ["Bingbot", "Bing (i deo ChatGPT pretrage)", "search", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"],
  ["Applebot", "Apple / Siri", "search", "Mozilla/5.0 (compatible; Applebot/0.1)"],
  ["Amazonbot", "Amazon / Alexa", "search", "Mozilla/5.0 (compatible; Amazonbot/0.1)"],
  ["CCBot", "Common Crawl (trening)", "training", "CCBot/2.0"],
  ["Bytespider", "ByteDance (trening)", "training", "Bytespider"],
];
const access = { tested_url: null, bots: [], files: {} };
if (args.site !== undefined) {
  const site = String(args.site).replace(/\/?$/, "/");
  const origin = new URL(site).origin;
  access.tested_url = items.find((d) => d.link)?.link ?? site;
  for (const [name, purpose, kind, ua] of BOTS) {
    let status = 0;
    try { status = (await fetch(access.tested_url, { headers: { "user-agent": ua }, redirect: "manual" })).status; } catch { /* */ }
    access.bots.push({ name, purpose, kind, status });
  }
  for (const p of ["/robots.txt", "/llms.txt", "/.well-known/ucp"]) {
    try { access.files[p] = (await fetch(origin + p, { headers: { "user-agent": BROWSER_UA } })).status; } catch { access.files[p] = 0; }
  }
  // trening crawlere je legitimno blokirati; pretraga i agenti koji rade za kupca treba da prolaze
  const wanted = access.bots.filter((b) => b.kind !== "training" && b.status);
  const blocked = wanted.filter((b) => b.status === 401 || b.status === 403);
  if (blocked.length) {
    checks.push({
      id: "bots", severity: "critical", title: "AI pretraga i agenti su blokirani",
      why: `Sajt vraća 403 za: ${blocked.map((b) => b.name).join(", ")}. Ti botovi dovode kupce (ChatGPT shopping, otvaranje linka za korisnika). Dok su blokirani, sajt za njih praktično ne postoji.`,
      fix: "U Cloudflareu (AI Crawl Control / WAF) propustiti pretraživače i agente koji rade za kupca; trening crawlere po želji blokirati ili naplaćivati.",
      affected: Math.round((N * blocked.length) / wanted.length), base: N, share: pct(Math.round((N * blocked.length) / wanted.length)),
      examples: [],
      note: "Test sa lažnim User-Agentom sa naše IP adrese; pravi botovi sa svojih IP adresa mogu proći drugačije. Potvrditi u Cloudflare → Security → Events.",
    });
  }
}

// ---------------------------------------------------------------- rendgen asortimana
const onSale = items.filter((d) => d._s);
const brands = [...groupBy("brand")].map(([name, L]) => {
  const s = L.filter((d) => d._s);
  return {
    name, items: L.length,
    sale_pct: pct(s.length, L.length),
    avg_disc: Math.round(avg(s.map((d) => d._disc)) * 1000) / 10,
    median_price: Math.round(median(L.map((d) => d._eff))),
    outlet_pct: pct(L.filter((d) => /outlet/i.test(d.custom_label_1 || "")).length, L.length),
    new_pct: pct(L.filter((d) => /new/i.test(d.custom_label_3 || "")).length, L.length),
  };
}).sort((a, b) => b.items - a.items);

const categories = [...groupBy("product_type")]
  .filter(([name]) => !isCatJoined(name))
  .map(([name, L]) => {
    const s = L.filter((d) => d._s);
    return { name, items: L.length, sale_pct: pct(s.length, L.length), avg_disc: Math.round(avg(s.map((d) => d._disc)) * 1000) / 10, median_price: Math.round(median(L.map((d) => d._eff))) };
  }).sort((a, b) => b.items - a.items);

const discBuckets = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((lo) => ({
  label: `${lo}–${lo + 9}%`,
  items: onSale.filter((d) => d._disc * 100 >= lo - 0.5 && d._disc * 100 < lo + 9.5).length,
})).filter((b, i, all) => all.slice(0, i + 1).some((x) => x.items) && all.slice(i).some((x) => x.items));

const BANDS = [[0, 3000], [3000, 5000], [5000, 10000], [10000, 20000], [20000, 40000], [40000, Infinity]];
const priceBands = BANDS.map(([lo, hi]) => ({
  label: hi === Infinity ? `${lo / 1000}k+` : `${lo / 1000}–${hi / 1000}k`,
  items: items.filter((d) => d._eff >= lo && d._eff < hi).length,
}));

const gender = Object.entries(items.reduce((a, d) => ((a[d.gender || "(prazno)"] = (a[d.gender || "(prazno)"] ?? 0) + 1), a), {}))
  .map(([name, n]) => ({ name, items: n }));

const summary = {
  items: N,
  brands: brands.length,
  categories: categories.length,
  in_stock_pct: pct(items.filter((d) => d.availability === "in stock").length),
  on_sale_pct: pct(onSale.length),
  avg_disc: Math.round(avg(onSale.map((d) => d._disc)) * 1000) / 10,
  deep_disc: onSale.filter((d) => d._disc >= 0.595).length,
  outlet_pct: pct(items.filter((d) => /outlet/i.test(d.custom_label_1 || "")).length),
  new_pct: pct(items.filter((d) => /new/i.test(d.custom_label_3 || "")).length),
  median_price: Math.round(median(items.map((d) => d._eff))),
  currency: items[0].currency || (items[0].price || "").split(" ")[1] || "",
  configurable: configurable.length,
};

const fill = [...fieldNames].sort().map((f) => ({
  field: f,
  filled: f === "additional_image_link" ? items.filter((d) => d.extra_images.length).length : label(f),
})).map((r) => ({ ...r, pct: pct(r.filled) }));

// skor 0–100: svaka provera skida W[severity] × udeo pogođenih
const penalty = checks.reduce((s, c) => s + W[c.severity] * Math.min(1, c.affected / c.base), 0);
const score = Math.max(0, Math.round(100 - penalty));
const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
checks.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || b.share - a.share);

const snapshot = {
  scanned_at: new Date().toISOString(),
  source: args.feed,
  score,
  items: N,
  data: { summary, checks: checks.filter((c) => c.affected > 0), passed: checks.filter((c) => c.affected === 0).map((c) => c.title), fill, brands, categories, disc_buckets: discBuckets, price_bands: priceBands, gender, variant_check: variantCheck, access },
};

const json = JSON.stringify(snapshot);
if (args.out) await writeFile(args.out, json);
console.error(`Artikala: ${N} · skor: ${score} · problema: ${snapshot.data.checks.length}`);

if (args.push) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !args["feed-id"]) { console.error("--push traži SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY i --feed-id"); process.exit(1); }
  const r = await fetch(`${url}/rest/v1/feed_snapshots`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({ feed_id: args["feed-id"], score, items: N, data: snapshot.data, scanned_at: snapshot.scanned_at }),
  });
  if (!r.ok) { console.error("Upis nije uspeo:", r.status, await r.text()); process.exit(1); }
  console.error("Snimak upisan.");
}
if (!args.out && !args.push) process.stdout.write(json);
