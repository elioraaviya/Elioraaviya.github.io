// Runs your prompt through Claude each morning and saves the result as news.json.
// No packages needed: uses Node's built-in fetch.
import { readFile, writeFile } from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5-5";
const MAX_SEARCHES = 20;

if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Add it under Settings > Secrets and variables > Actions.");
  process.exit(1);
}

// Fill in today's date (UK time) wherever the prompt says {{date}}.
const today = new Date().toLocaleDateString("en-GB", {
  timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric"
});
const prompt = (await readFile("prompt.txt", "utf8")).replaceAll("{{date}}", today);

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }]
    })
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Long searches can pause partway; keep going until Claude finishes.
let messages = [{ role: "user", content: prompt }];
let reply;
for (let i = 0; i < 5; i++) {
  reply = await callClaude(messages);
  if (reply.stop_reason !== "pause_turn") break;
  messages = [...messages, { role: "assistant", content: reply.content }];
}

// Take the text Claude wrote after its last search, and pull out the JSON.
const blocks = reply.content;
const lastSearch = blocks.map(b => b.type).lastIndexOf("web_search_tool_result");
const text = blocks.slice(lastSearch + 1).filter(b => b.type === "text").map(b => b.text).join("\n");
const clean = text.replace(/```json|```/g, "");
const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
if (start === -1 || end === -1) throw new Error("No JSON in Claude's reply:\n" + text);
const raw = JSON.parse(clean.slice(start, end + 1));

// Safety checks: right section names, max 10 each, nothing older than 3 days, no repeated links.
const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
const seen = new Set();
function tidy(list) {
  return (Array.isArray(list) ? list : [])
    .filter(s => s && s.headline && s.url)
    .filter(s => { const d = Date.parse(s.date); return isNaN(d) || d >= cutoff; })
    .filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; })
    .slice(0, 10);
}
const news = {
  updated: new Date().toISOString(),
  intersection: tidy(raw.intersection ?? raw.intersect),
  sports: tidy(raw.sports ?? raw.sport),
  fashion: tidy(raw.fashion),
  marketing: tidy(raw.marketing)
};

const total = news.sports.length + news.fashion.length + news.marketing.length + news.intersection.length;
if (total === 0) throw new Error("Claude returned no stories, so yesterday's news.json was kept.");

await writeFile("news.json", JSON.stringify(news, null, 2));
console.log(`Saved ${total} stories for ${today}.`);
