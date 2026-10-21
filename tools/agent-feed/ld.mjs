// Karton proizvoda (schema.org JSON-LD) iz Agent Feeda, za Cloudflare Worker koji ga ubacuje u stranicu proizvoda
// (workers/product-ld). Isti podaci kao u našem feedu: pun naziv sa modelom, sve veličine sa sajta, boja, pol.
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

function offer(d, url, availability) {
  const price = num(d.price), sale = num(d.sale_price), cur = currency(d.price);
  const o = { "@type": "Offer", url, priceCurrency: cur, price: sale ?? price, availability, itemCondition: "https://schema.org/NewCondition" };
  if (sale != null && price != null && sale < price) {
    o.priceSpecification = [
      { "@type": "UnitPriceSpecification", price: sale, priceCurrency: cur },
      { "@type": "UnitPriceSpecification", price, priceCurrency: cur, priceType: "https://schema.org/StrikethroughPrice" },
    ];
  }
  return o;
}

/** d = proizvod iz feeda posle ispravki (d._title, d._images), sizes = veličine sa sajta ([] ako nisu poznate) */
export function card(d, sizes) {
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
      hasVariant: sizes.map((s) => ({ "@type": "Product", sku: `${d.id}-${s}`, name: `${d._title}, veličina ${s}`, size: s, image: base.image[0], offers: offer(d, url, availability) })),
    };
  }
  const size = sizes[0] ?? d.size;
  return { "@context": "https://schema.org", "@type": "Product", ...base, url, productID: d.id, sku: d.mpn || d.id, mpn: d.mpn || undefined, size: size || undefined, offers: offer(d, url, availability) };
}

/** Svi kartoni podeljeni po delovima: { "a3": { "/rs/…/": {…}, … }, … } */
export function shards(items, cache) {
  const out = {};
  for (const d of items) {
    const path = pathOf(d.link);
    if (!path) continue;
    (out[shardOf(path)] ??= {})[path] = card(d, cache[d.id]?.s ?? []);
  }
  return out;
}
