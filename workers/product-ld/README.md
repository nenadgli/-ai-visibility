# product-ld: karton proizvoda iz Agent Feeda na stranici proizvoda

Cloudflare Worker koji na sajtu klijenta u stranicu proizvoda ubacuje karton (schema.org JSON-LD) iz našeg Agent Feeda:
pun naziv sa modelom, sve veličine sa sajta (`ProductGroup` + varijanta po veličini), boja, pol, cena i akcijska cena.
Kupac vidi istu stranicu; menja se samo karton koji čitaju Google, ChatGPT, Perplexity i ostali. Stranica je ista za sve
posetioce, pa ovo nije cloaking.

## Kako radi

1. Agent Feed (`tools/agent-feed/build.mjs` + `ld.mjs`) svakog sata pravi kartone i objavljuje ih u 256 delova:
   `feeds/<token>/ld/<xx>.json`, gde je `xx` prva dva hex znaka `sha1(putanja stranice)`. Šalju se samo izmenjeni delovi.
2. Worker za svaku HTML stranicu uzme stranicu iz Magenta, preuzme deo sa kartonom (Cloudflare ga kešira sat vremena)
   i zameni Magento karton tipa `Product` našim. Ostali kartoni (`Store`, `BreadcrumbList`, `WebPage`) ostaju.
3. Ako kartona nema ili naš server ne odgovara, vraća originalnu stranicu bez izmena. Ubačena stranica ima zaglavlje
   `x-agent-feed-ld: 1`.

## Postavljanje na sajtu klijenta

Treba pristup Cloudflare nalogu klijenta (ili da hosting uradi korake 2–3).

1. U `wrangler.toml` proveriti `LD_BASE` (token feeda iz tabele `agent_feeds`) i `ORIGIN = ""`.
2. `npx wrangler deploy` (ili Cloudflare → Workers → Create → nalepiti `src/index.js`, pa dodati promenljivu `LD_BASE`).
3. Ruta: prvo jedan proizvod, npr. `www.fashionandfriends.com/rs/poluduboke-muske-cipele-sa-logotipom-brenda-timberland-t95100/*`,
   pa posle provere `www.fashionandfriends.com/rs/*`.
4. Provera: Google Rich Results Test (https://search.google.com/test/rich-results) za taj link treba da pokaže
   "Product snippets" / "Merchant listings" sa varijantama po veličini.

Gašenje: obrisati rutu u Cloudflare-u. Sajt odmah radi kao pre.

Trošak: Workers Free do 100.000 zahteva dnevno; Workers Paid $5 mesečno za 10 miliona.

## Lokalna proba

```sh
npx wrangler dev --port 8787 --var ORIGIN:https://www.fashionandfriends.com
curl -sD - http://localhost:8787/rs/poluduboke-muske-cipele-sa-logotipom-brenda-timberland-t95100/ -o /tmp/p.html | grep x-agent-feed
```
