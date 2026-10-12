import { assert, assertEquals } from "jsr:@std/assert@1";
import { runChatGPT, runClaude, runGemini, runGoogleAIO, runPerplexity } from "../_shared/providers.ts";
import { detectMentions } from "../_shared/analyze.ts";
import { MARKETS } from "../_shared/types.ts";

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
}
const M = MARKETS.RS;

Deno.test("chatgpt parser", async () => {
  mockFetch(() => ({
    model: "gpt-5.5",
    output: [
      { type: "web_search_call", action: { type: "search", query: "najbolje patike online srbija", sources: [{ type: "url", url: "https://www.buzzsneakers.rs/a?utm_source=openai" }, { type: "url", url: "https://fashionandfriends.com/rs" }] } },
      { type: "web_search_call", action: { type: "search", queries: ["nike patike popust beograd"], sources: [] } },
      { type: "message", content: [{ type: "output_text", text: "Probajte Buzz i Fashion&Friends.", annotations: [{ type: "url_citation", start_index: 9, end_index: 13, url: "https://www.buzzsneakers.rs/a?utm_source=openai", title: "Buzz" }] }] },
    ],
  }));
  const r = await runChatGPT("gde kupiti patike", M);
  assertEquals(r.queries, ["najbolje patike online srbija", "nike patike popust beograd"]);
  assertEquals(r.sources.length, 2);
  assertEquals(r.citations[0].start_index, 9);
  assert(r.used_search);
});

Deno.test("claude parser", async () => {
  mockFetch(() => ({
    model: "claude-sonnet-5-5", stop_reason: "end_turn",
    content: [
      { type: "text", text: "Pretražiću." },
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "online prodavnice odeće srbija" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://www.fashionandfriends.com/", title: "F&F", page_age: "2026" }, { type: "web_search_result", url: "https://zara.com/rs", title: "Zara" }] },
      { type: "text", text: "Fashion&Friends ima širok izbor.", citations: [{ type: "web_search_result_location", url: "https://www.fashionandfriends.com/", title: "F&F", cited_text: "Najveći izbor brendova" }] },
    ],
  }));
  const r = await runClaude("gde kupiti odeću", M);
  assertEquals(r.queries, ["online prodavnice odeće srbija"]);
  assertEquals(r.sources[0].query_idx, 0);
  assertEquals(r.citations.length, 1);
  assertEquals(r.citations[0].cited_text, "Najveći izbor brendova");
});

Deno.test("gemini parser + redirect", async () => {
  const answer = "Najpoznatiji su Zara i Fashion&Friends. Takođe Buzz.";
  mockFetch((url) => {
    if (url.includes("grounding-api-redirect")) return new Response(null, { status: 302, headers: { location: "https://www.zara.com/rs/" } });
    return {
      modelVersion: "gemini-3-flash",
      candidates: [{
        content: { parts: [{ text: answer }] },
        groundingMetadata: {
          webSearchQueries: ["prodavnice odeće beograd"],
          groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "zara.com" } }],
          groundingSupports: [{ segment: { startIndex: 0, endIndex: 40, text: "Najpoznatiji su Zara i Fashion&Friends." }, groundingChunkIndices: [0] }],
        },
      }],
    };
  });
  const r = await runGemini("prodavnice odeće", M);
  assertEquals(r.sources[0].url, "https://www.zara.com/rs/");
  assertEquals(r.citations[0].start_index, 0);
  assertEquals(r.queries.length, 1);
});

Deno.test("perplexity parser", async () => {
  mockFetch(() => ({
    model: "sonar-pro",
    choices: [{ message: { content: "Buzz je popularan [1]. F&F takođe [2][1]." } }],
    search_results: [{ url: "https://buzzsneakers.rs", title: "Buzz" }, { url: "https://fashionandfriends.com", title: "FF" }],
  }));
  const r = await runPerplexity("patike", M);
  assertEquals(r.citations.length, 3);
  assertEquals(r.citations[1].url, "https://fashionandfriends.com");
});

Deno.test("google aio parser", async () => {
  mockFetch(() => ({
    search_metadata: { id: "x" },
    organic_results: [{ link: "https://a.rs", title: "A" }],
    ai_overview: {
      text_blocks: [
        { type: "paragraph", snippet: "Za patike u Beogradu:", reference_indexes: [0] },
        { type: "list", list: [{ title: "Buzz:", snippet: "širok izbor", reference_indexes: [1] }] },
      ],
      references: [{ index: 0, link: "https://a.rs", title: "A" }, { index: 1, link: "https://buzzsneakers.rs/#:~:text=%C5%A1irok%20izbor", title: "Buzz" }],
    },
  }));
  const r = await runGoogleAIO("patike beograd", M);
  assert(!r.empty);
  assertEquals(r.citations.length, 2);
  assertEquals(r.citations[1].cited_text, "širok izbor");
  assert(r.answer.includes("• Buzz:"));
});

Deno.test("mention detection (padeži, alias, rang)", () => {
  const brands = [
    { id: "ff", name: "Fashion & Friends", aliases: ["F&F"], domains: ["fashionandfriends.com"], is_own: true },
    { id: "zara", name: "Zara", aliases: [], domains: ["zara.com"], is_own: false },
    { id: "buzz", name: "Buzz", aliases: ["Buzz Sneakers"], domains: ["buzzsneakers.rs"], is_own: false },
  ];
  const text = "U Zari i Buzz-u ima popusta. Fashion&Friends-u je izbor najveći. Zarada nije bitna. F&F ima Nike.";
  const hits = detectMentions(text, brands, new Set(["fashionandfriends.com"]));
  const by = Object.fromEntries(hits.map((h) => [h.brand_id, h]));
  assertEquals(by.zara.mention_count, 1, "Zari da, Zarada ne");
  assertEquals(by.zara.rank, 1);
  assertEquals(by.buzz.rank, 2);
  assertEquals(by.ff.mention_count, 2);
  assert(by.ff.linked);
});
