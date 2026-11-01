// Runs your prompt through Claude each morning and saves the result as news.json.
// No packages needed: uses Node's built-in fetch.
import { readFile, writeFile } from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5-5";
const MAX_SEARCHES = 20;
const ATTEMPTS = 2; // if a run comes back without usable JSON, try once more

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
      max_tokens: 16000,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }]
    })
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Ask Claude, following up if a long search pauses partway. Returns all the text it wrote.
async function getReplyText() {
  let messages = [{ role: "user", content: prompt }];
  let allText = "";
  for (let i = 0; i < 6; i++) {
    const reply = await callClaude(messages);
    const types = reply.content.map(b => b.type);
    console.log(`Reply ${i + 1}: stop_reason=${reply.stop_reason}, searches=${types.filter(t => t === "server_tool_use").length}`);
    allText += reply.content.filter(b => b.type === "text").map(b => b.text).join("");
    if (reply.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: reply.content }];
  }
  return allText;
}

// Find the news JSON anywhere in Claude's text, ignoring any chat before or after it.
function extractNews(text) {
  const clean = text.replace(/```json|```/g, "").replace(/[\u0000-\u001F]+/g, " ");
  const end = clean.lastIndexOf("}");
  let start = clean.indexOf("{");
  while (start !== -1 && start < end) {
    try {
      const obj = JSON.parse(clean.slice(start, end + 1));
      if (obj && typeof obj === "object" &&
          ["sports", "sport", "fashion", "marketing", "intersection", "intersect"].some(k => k in obj)) {
        return obj;
      }
    } catch { /* not valid from here; try the next { */ }
    start = clean.indexOf("{", start + 1);
  }
  return null;
}

let raw = null;
for (let attempt = 1; attempt <= ATTEMPTS && !raw; attempt++) {
  const text = await getReplyText();
  raw = extractNews(text);
  if (!raw) console.log(`Attempt ${attempt}: no usable JSON. Claude wrote:\n${text.slice(0, 1500) || "(nothing)"}`);
}
if (!raw) throw new Error("No usable JSON after retrying, so yesterday's news.json was kept.");

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
