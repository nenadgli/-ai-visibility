# product-ld: karton proizvoda iz Agent Feeda na stranici proizvoda

Cloudflare Worker koji na sajtu klijenta u stranicu proizvoda ubacuje karton (schema.org JSON-LD) iz našeg Agent Feeda:
pun naziv sa modelom, sve veličine sa sajta (`ProductGroup` + varijanta po veličini), boja, pol, cena i akcijska cena.
Kupac vidi istu stranicu; menja se samo karton koji čitaju Google, ChatGPT, Perplexity i ostali. Stranica je ista za sve
posetioce, pa ovo nije cloaking.

## Šta je u kartonu

- **Proizvod:** pun naziv sa modelom, brend, boja, pol, slike, sve veličine sa sajta (`ProductGroup` + varijante).
- **Akcija:** precrtana cena (`StrikethroughPrice`) i opis ponude, npr. „Akcija -40%: 5.694 RSD umesto 9.490 RSD“.
- **Dostava i povrat** iz `agent_feeds.config.policy` (cena i rok dostave, dani za povrat, ko plaća povratnu poštarinu):
  ```json
  { "country": "RS", "shipping": { "price": 350, "handling_days": [0, 1], "transit_days": [2, 4] },
    "returns": { "days": 14, "customer_pays_shipping": true } }
  ```
- **Česta pitanja:** `agent_feeds.config.faq_url` → `FAQPage` karton na toj istoj stranici (pitanja su tamo vidljiva,
  kako Google traži). Agent Feed ih čita sa stranice svakog sata.

Podaci o dostavi i povratu moraju biti prepisani sa sajta klijenta (stranice „Naručivanje i plaćanje“ i „Odustanak od kupovine“),
nikad pretpostavljeni.

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

## Proba sa ChatGPT-om pre postavljanja na sajt klijenta

Worker se postavi na sopstveni besplatni Cloudflare nalog (adresa `product-ld.<nalog>.workers.dev`) sa
`ORIGIN = "https://www.fashionandfriends.com"` i `PROBA = "1"`. U tom režimu radi samo na stranicama za koje imamo karton,
na vrhu prikazuje traku „Probna kopija… nije prodavnica“ sa linkom na original i zabranjuje indeksiranje
(`noindex`, `X-Robots-Tag`). ChatGPT-u se da link probne kopije i pita isto što i za originalnu stranicu.
Posle probe Worker se obriše.

## Lokalna proba

```sh
npx wrangler dev --port 8787 --var ORIGIN:https://www.fashionandfriends.com
curl -sD - http://localhost:8787/rs/poluduboke-muske-cipele-sa-logotipom-brenda-timberland-t95100/ -o /tmp/p.html | grep x-agent-feed
```
