# AI Vidljivost

Interni alat agencije: postavlja upite ChatGPT-u, Claude-u, Geminiju, Perplexityju i Google AI Overviews-u i čuva **ceo put do odgovora**:

pitanje → pretrage koje je AI sam generisao (fan-out) → stranice koje je pročitao → stranice koje je citirao → koji deo odgovora se oslanja na koji izvor → koji brendovi su pomenuti, kojim redom, kojim tonom i zašto.

## Delovi

| Deo | Gde |
|---|---|
| Baza + RPC analitika | Supabase projekat `ai-visibility` (`prfcnhlunpnewankxhdn`, Frankfurt) — `supabase/migrations/` |
| Obrada (red čekanja, pozivi AI sistema, analiza) | Edge funkcija `api` — `supabase/functions/` |
| Dashboard | React + Vite — `web/` |

## Šta svaki sistem otkriva

| Sistem | Fan-out pretrage | Pročitano | Citirano + pozicija u tekstu | Tačan citirani tekst |
|---|---|---|---|---|
| ChatGPT (Responses API, `web_search`) | da | da (`action.sources`) | da | ne |
| Claude (`web_search` server tool) | da | da | da | da (`cited_text`) |
| Gemini (Google Search grounding) | da | da (redirect linkovi se razrešavaju) | da | ne |
| Perplexity (Sonar) | ne (API ih ne vraća) | da | da (oznake [n]) | ne |
| Google AI Overviews (SerpApi) | = pitanje | top 10 organskih + reference | da | često (`#:~:text=`) |

## Podešavanje ključeva

Supabase → Edge Functions → Secrets (ili `supabase secrets set`):

```
OPENAI_API_KEY      ChatGPT
ANTHROPIC_API_KEY   Claude
GEMINI_API_KEY      Gemini + analiza tona/razloga (obavezno za analizu)
PERPLEXITY_API_KEY  Perplexity
SERPAPI_API_KEY     Google AI Overviews
```

Opciono (podrazumevane vrednosti u zagradi):
`OPENAI_MODEL` (gpt-5.5), `CLAUDE_MODEL` (claude-sonnet-5-5), `CLAUDE_SEARCH_TOOL` (web_search_20250305), `GEMINI_MODEL` (gemini-3-flash-preview), `PERPLEXITY_MODEL` (sonar-pro), `ANALYSIS_MODEL` (gemini-2.5-flash), `WORKER_BATCH` (6).

Sistem bez ključa je u aplikaciji samo isključen.

## Pokretanje dashboarda

```bash
cd web
cp .env.example .env    # URL i publishable ključ su već upisani
npm install
npm run dev             # lokalno
npm run build           # dist/ za Vercel ili bilo koji statički hosting
```

Na Vercelu: **Root Directory = `web`** (Settings → Build and Deployment). Ostalo čita iz `web/vercel.json`. Env: `VITE_SUPABASE_URL` i `VITE_SUPABASE_ANON_KEY`.

## Kako radi obrada

1. `start_run` napravi po jedan red u `responses` za svaki upit × sistem × ponavljanje.
2. Edge funkcija preuzme do 6 poslova (`claim_responses`, bez dupliranja), pozove sisteme paralelno, normalizuje odgovor i upiše pretrage, izvore i citate.
3. Prepoznavanje brendova je pravilima (nazivi, alijasi, domeni, srpski padeži: Zara/Zare/Zari), a ton, preporuka, razlozi i nepraćeni brendovi preko Geminija.
4. Ako ima još posla, funkcija pozove samu sebe. 429/5xx se ponavlja do 3 puta.

## Feed X-ray

Stranica **Feed X-ray** pokazuje šta product feed klijenta govori o kvalitetu podataka (ono što Google i AI agenti vide) i o samom asortimanu: skor 0–100, problemi po težini sa primerima, pristup AI botova, popusti po brendu i kategoriji, cenovni razredi i popunjenost polja.

Feed od 50+ MB je prevelik za edge funkciju, pa skeniranje radi skripta bez zavisnosti (Node 22+):

```bash
# 1. jednom: red u tabeli feeds (workspace, url feeda, url sajta)
# 2. skeniranje + upis snimka
NODE_USE_ENV_PROXY=1 \
SUPABASE_URL=https://prfcnhlunpnewankxhdn.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
node tools/feed-xray/scan.mjs \
  --feed https://fashion-assets.fashionandfriends.com/media/feed/product-feed-rs.xml \
  --site https://www.fashionandfriends.com/rs/ --sample 30 \
  --push --feed-id <id iz tabele feeds>
```

**Dnevno skeniranje:** `.github/workflows/feed-xray.yml` svakog jutra (04:17 UTC) pokreće `scan.mjs --all`, koji skenira sve feedove iz tabele `feeds`. Potreban je GitHub secret `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API keys). Ručno pokretanje: Actions → Feed X-ray → Run workflow. Novi klijent = novi red u `feeds`, ništa drugo.

Bez `--push` snimak ide na stdout (ili u `--out fajl.json`). `--site` uključuje proveru uzorka proizvodnih stranica (veličine na sajtu vs. feed, Magento `jsonConfig`) i test pristupa AI botova (User-Agent sa naše IP adrese, rezultat treba potvrditi u Cloudflareu). Svaki snimak se čuva, pa se kasnije može pratiti promena kroz vreme.

## Testovi

```bash
cd supabase/functions && deno test --allow-net --allow-env tests/
```

Parseri za svih 5 sistema + prepoznavanje brendova, na primerima odgovora iz dokumentacije.

## Pristup

Prijava email + lozinka (Supabase Auth). Trenutno svaki ulogovani korisnik vidi sve klijente. Pre nego što link dobije neko van agencije: isključiti registraciju u Supabase → Authentication → Sign In / Providers, ili uvesti listu dozvoljenih emailova.
