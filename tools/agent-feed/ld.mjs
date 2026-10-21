// Karton proizvoda (schema.org JSON-LD) iz Agent Feeda, za Cloudflare Worker koji ga ubacuje u stranicu proizvoda
// (workers/product-ld). Isti podaci kao u našem feedu: pun naziv sa modelom, sve veličine sa sajta, boja, pol.
//
// Dostava i povrat (agent_feeds.config.policy) idu u svaku ponudu, da AI uz proizvod zna cenu i rok dostave
// i uslove povrata. Česta pitanja (config.faq_url) postaju FAQPage karton na toj istoj stranici, gde su vidljiva.
//
// Kartoni se objavljuju u 256 delova po prva dva hex znaka sha1(putanje stranice), da Worker po zahtevu
// preuzme samo jedan mali fajl (Cloudflare ga kešira). Putanja = pathname linka iz feeda, sa "/" na kraju.

import { createHash } from "node:crypto";

export const pathOf = (link) => {
  try {
    const p = new URL(link).pathname;
    return p.endsWith("/") ? p : `${p}/`;
  } catch { return null; }
};
export const shardOf = (path) => createHash("sha1").update(path).digest("hex").slice(0, 2);

const AVAIL = { "in stock": "https://schema.org/InStock", "out of stock": "https://schema.org/OutOfStock", preorder: "https://schema.org/PreOrder", backorder: "https://schema.org/BackOrder" };
const GENDER = { male: "https://schema.org/Male", female: "https://schema.org/Female" };
const num = (v) => { const m = /^[\d.]+/.exec(v ?? ""); return m ? Number(m[0]) : null; };
const currency = (v) => /\b([A-Z]{3})\b/.exec(v ?? "")?.[1] ?? "RSD";

const fmt = (n) => Math.round(n).toLocaleString("sr-RS");
const days = ([min, max]) => ({ "@type": "QuantitativeValue", minValue: min, maxValue: max, unitCode: "DAY" });

/** policy = agent_feeds.config.policy:
 *  { country: "RS", shipping: { price: 350, handling_days: [0, 1], transit_days: [2, 4] },
 *    returns: { days: 14, customer_pays_shipping: true } } */
function policyParts(policy, cur) {
  const out = {};
  const sh = policy?.shipping;
  if (sh && sh.price != null) {
    out.shippingDetails = {
      "@type": "OfferShippingDetails",
      shippingRate: { "@type": "MonetaryAmount", value: sh.price, currency: cur },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: policy.country },
      ...(sh.handling_days && sh.transit_days
        ? { deliveryTime: { "@type": "ShippingDeliveryTime", handlingTime: days(sh.handling_days), transitTime: days(sh.transit_days) } }
        : {}),
    };
  }
  const rt = policy?.returns;
  if (rt && rt.days) {
    out.hasMerchantReturnPolicy = {
      "@type": "MerchantReturnPolicy",
      applicableCountry: policy.country,
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: rt.days,
      returnMethod: "https://schema.org/ReturnByMail",
      returnFees: rt.customer_pays_shipping ? "https://schema.org/ReturnFeesCustomerResponsibility" : "https://schema.org/FreeReturn",
      refundType: "https://schema.org/FullRefund",
    };
  }
  return out;
}

function offer(d, url, availability, policy) {
  const price = num(d.price), sale = num(d.sale_price), cur = currency(d.price);
  const o = { "@type": "Offer", url, priceCurrency: cur, price: sale ?? price, availability, itemCondition: "https://schema.org/NewCondition" };
  if (sale != null && price != null && sale < price) {
    // akcija: precrtana cena (Google) + opis koji AI prenosi doslovno
    o.name = `Akcija -${Math.round((100 * (price - sale)) / price)}%: ${fmt(sale)} ${cur} umesto ${fmt(price)} ${cur}`;
    o.priceSpecification = [
      { "@type": "UnitPriceSpecification", price: sale, priceCurrency: cur },
      { "@type": "UnitPriceSpecification", price, priceCurrency: cur, priceType: "https://schema.org/StrikethroughPrice" },
    ];
  }
  return { ...o, ...policyParts(policy, cur) };
}

// Dostava i povrat su isti za sve veličine: pun opis u prvoj varijanti (sa @id), ostale samo upućuju na njega
const SHIP_ID = "#dostava", RET_ID = "#povrat";
function shared(o, i) {
  if (o.shippingDetails) o.shippingDetails = i ? { "@id": SHIP_ID } : { "@id": SHIP_ID, ...o.shippingDetails };
  if (o.hasMerchantReturnPolicy) o.hasMerchantReturnPolicy = i ? { "@id": RET_ID } : { "@id": RET_ID, ...o.hasMerchantReturnPolicy };
  return o;
}

/** d = proizvod iz feeda posle ispravki (d._title, d._images), sizes = veličine sa sajta ([] ako nisu poznate) */
export function card(d, sizes, policy) {
  const url = d.link;
  const base = {
    name: d._title,
    description: (d.description || "").slice(0, 5000) || undefined,
    image: [d.image_link, ...(d._images ?? [])].filter(Boolean),
    brand: d.brand ? { "@type": "Brand", name: d.brand } : undefined,
    color: d.color || undefined,
    audience: GENDER[d.gender] ? { "@type": "PeopleAudience", suggestedGender: GENDER[d.gender], ...(d._age === "kids" ? { suggestedMaxAge: 13 } : {}) } : undefined,
  };
  const availability = AVAIL[(d.availability || "").toLowerCase()] ?? "https://schema.org/InStock";
  if (sizes.length > 1) {
    // ProductGroup + jedna varijanta po veličini (Google: "Product variants" structured data)
    return {
      "@context": "https://schema.org", "@type": "ProductGroup", ...base,
      url, productGroupID: d.id, sku: d.mpn || undefined, variesBy: ["https://schema.org/size"],
      hasVariant: sizes.map((s, i) => ({ "@type": "Product", sku: `${d.id}-${s}`, name: `${d._title}, veličina ${s}`, size: s, image: base.image[0], offers: shared(offer(d, url, availability, policy), i) })),
    };
  }
  const size = sizes[0] ?? d.size;
  return { "@context": "https://schema.org", "@type": "Product", ...base, url, productID: d.id, sku: d.mpn || d.id, mpn: d.mpn || undefined, size: size || undefined, offers: offer(d, url, availability, policy) };
}

/** Svi kartoni podeljeni po delovima: { "a3": { "/rs/…/": {…}, … }, … }; extra = dodatni kartoni po URL-u (npr. FAQ) */
export function shards(items, cache, policy, extra = {}) {
  const out = {};
  for (const d of items) {
    const path = pathOf(d.link);
    if (!path) continue;
    (out[shardOf(path)] ??= {})[path] = card(d, cache[d.id]?.s ?? [], policy);
  }
  for (const [url, c] of Object.entries(extra)) {
    const path = pathOf(url);
    if (path) (out[shardOf(path)] ??= {})[path] = c;
  }
  return out;
}

// ---------------------------------------------------------------- česta pitanja → FAQPage
const decodeHtml = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
// Cloudflare skriva email adrese (data-cfemail); vraćamo ih u čitljiv oblik
const cfEmail = (hex) => { const k = parseInt(hex.slice(0, 2), 16); let e = ""; for (let i = 2; i < hex.length; i += 2) e += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return e; };
const toText = (html) => decodeHtml(html
  .replace(/<a[^>]*data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/a>/gi, (_, h) => cfEmail(h))
  .replace(/<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, "").trim()} (${href})`)
  .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " "))
  .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/** Pitanja i odgovori sa stranice čestih pitanja (Magento FAQ: <h5>pitanje</h5><div class="faq-content-text">odgovor</div>) */
export function faqCard(html, url) {
  const qa = [];
  for (const m of html.matchAll(/<h5[^>]*>([\s\S]*?)<\/h5>\s*<div class="faq-content-text">([\s\S]*?)<\/div>/g)) {
    const q = toText(m[1]), a = toText(m[2]);
    if (q && a) qa.push({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } });
  }
  return qa.length ? { "@context": "https://schema.org", "@type": "FAQPage", url, mainEntity: qa } : null;
}
