// Cloudflare Worker: u stranicu proizvoda ubacuje karton (schema.org JSON-LD) iz Agent Feeda.
// Kupac vidi istu stranicu; menja se samo karton koji čitaju Google i AI (pun naziv, sve veličine, boja, pol).
//
// Radi na sajtu klijenta (route npr. www.fashionandfriends.com/rs/*). Za svaku HTML stranicu:
//   1. uzme stranicu iz Magenta kao i do sada,
//   2. po putanji nađe naš karton (deo ld/<xx>.json, xx = prva dva hex znaka sha1(putanje)),
//   3. zameni Magento karton tipa Product našim; ostale kartone (Store, BreadcrumbList…) ne dira.
// Ako bilo šta ne uspe ili kartona nema, vraća originalnu stranicu bez izmena.
//
// Promenljive (wrangler.toml → [vars]):
//   LD_BASE  javna adresa delova, npr. https://<projekat>.supabase.co/storage/v1/object/public/feeds/<token>/ld
//   ORIGIN   samo za probu: odakle se uzima stranica (npr. https://www.fashionandfriends.com); na pravom sajtu prazno

const MARK = "data-agent-feed"; // oznaka na ubačenom kartonu, da se vidi odakle je

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upstream = env.ORIGIN ? new Request(new URL(url.pathname + url.search, env.ORIGIN), request) : request;
    const page = await fetch(upstream);

    if (request.method !== "GET" || page.status !== 200 || !(page.headers.get("content-type") || "").includes("text/html")) return page;

    let card = null;
    try {
      card = await findCard(url.pathname, env, ctx);
    } catch (e) {
      console.log("karton nije učitan:", e && e.message);
    }
    if (!card) return page;

    return replaceProductCard(page, card);
  },
};

const pathOf = (p) => (p.endsWith("/") ? p : `${p}/`);

async function sha1hex(s) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function findCard(pathname, env) {
  if (!env.LD_BASE) return null;
  const path = pathOf(pathname);
  const shard = (await sha1hex(path)).slice(0, 2);
  // Cloudflare kešira deo sat vremena; Agent Feed ih osvežava svakog sata
  const r = await fetch(`${env.LD_BASE}/${shard}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) return null;
  const cards = await r.json();
  return cards[path] ?? null;
}

// Zamena Magento kartona tipa Product; ako ga nema, naš karton ide na kraj <head>.
function replaceProductCard(page, card) {
  const json = JSON.stringify(card).replace(/</g, "\\u003c"); // bez "</script>" unutar JSON-a
  let replaced = false;
  let buf = "";
  const rewriter = new HTMLRewriter()
    .on('script[type="application/ld+json"]', {
      text(t) {
        // sadržaj stiže u delovima: skupljamo ga i odlučujemo na poslednjem delu
        buf += t.text;
        if (!t.lastInTextNode) { t.remove(); return; }
        const isProduct = /"@type"\s*:\s*"(Product|ProductGroup)"/.test(buf);
        if (isProduct && !replaced) { t.replace(json, { html: true }); replaced = true; }
        else if (isProduct) t.replace("", { html: true }); // drugi Product karton bi protivrečio našem
        else t.replace(buf, { html: true });
        buf = "";
      },
    })
    .on("head", {
      element(el) {
        el.onEndTag((end) => {
          if (!replaced) { end.before(`<script type="application/ld+json" ${MARK}>${json}</script>`, { html: true }); replaced = true; }
        });
      },
    });
  const res = rewriter.transform(page);
  const out = new Response(res.body, res);
  out.headers.set("x-agent-feed-ld", "1");
  out.headers.delete("content-length");
  return out;
}
