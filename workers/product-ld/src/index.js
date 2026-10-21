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
//   PROBA    "1" = probna kopija na tuđoj adresi (npr. workers.dev, da je otvori ChatGPT): radi samo na stranicama
//            za koje imamo karton, dodaje traku "probna kopija" i zabranjuje indeksiranje (noindex)

const MARK = "data-agent-feed"; // oznaka na ubačenom kartonu, da se vidi odakle je

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let upstream = env.ORIGIN ? new Request(new URL(url.pathname + url.search, env.ORIGIN), request) : request;
    // Probna kopija: stranicu uzimamo kao pregledač. Inače bi Cloudflare klijenta odbio ChatGPT-ov User-Agent (403)
    // i proba ne bi pokazala da li AI čita karton. Na pravom sajtu Worker radi tek posle Cloudflare zaštite,
    // pa tamo AI botovi moraju biti propušteni u podešavanjima.
    // Nov zahtev bez zaglavlja posetioca: ChatGPT šalje i potpis (Signature, Signature-Agent) po kome ga Cloudflare prepozna.
    if (env.PROBA === "1") {
      upstream = new Request(upstream.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "sr-RS,sr;q=0.9,en;q=0.8",
        },
      });
    }
    const page = await fetch(upstream);
    if (env.PROBA === "1") console.log(`proba: ${request.headers.get("user-agent")} → izvor ${page.status}`);
    if (env.PROBA === "1" && page.status !== 200) {
      return new Response(`Probna kopija: originalni sajt je vratio HTTP ${page.status} za ${upstream.url}`, { status: 502, headers: { "x-origin-status": String(page.status) } });
    }

    if (request.method !== "GET" || page.status !== 200 || !(page.headers.get("content-type") || "").includes("text/html")) return page;

    let card = null;
    try {
      card = await findCard(url.pathname, env, ctx);
    } catch (e) {
      console.log("karton nije učitan:", e && e.message);
    }
    if (!card) return env.PROBA === "1" ? new Response("Probna kopija radi samo za stranice proizvoda iz feeda.", { status: 404 }) : page;

    const out = replaceProductCard(page, card);
    return env.PROBA === "1" ? markAsTest(out, upstream.url) : out;
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

// Probna kopija: vidljiva traka sa linkom na original, bez indeksiranja, relativni linkovi vode na pravi sajt
function markAsTest(res, originalUrl) {
  const origin = new URL(originalUrl).origin;
  const out = new HTMLRewriter()
    .on("head", { element(el) { el.prepend(`<base href="${origin}/"><meta name="robots" content="noindex, nofollow">`, { html: true }); } })
    .on("body", {
      element(el) {
        el.prepend(`<div style="position:sticky;top:0;z-index:99999;background:#1c4fa8;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:8px 16px">
Probna kopija za proveru podataka koje čitaju AI asistenti (AI Vidljivost). Ovo nije prodavnica.
Original: <a style="color:#fff;text-decoration:underline" href="${originalUrl}">${originalUrl}</a></div>`, { html: true });
      },
    })
    .transform(res);
  const r = new Response(out.body, out);
  r.headers.set("x-robots-tag", "noindex, nofollow");
  return r;
}
