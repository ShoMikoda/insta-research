#!/usr/bin/env node
// キーワードからInstagramアカウントを発掘する。
// DuckDuckGoで「site:instagram.com <キーワード>」を検索して候補を集め、
// Bright Data Profilesスクレイパーで詳細(フォロワー数等)を取得してランキング化。
// 使い方: BRIGHTDATA_API_KEY=xxx node scripts/discover.mjs "スニーカー"

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = process.env.BRIGHTDATA_API_KEY;
const keyword = process.argv[2]?.trim();
if (!API_KEY || !keyword) {
  console.error("使い方: BRIGHTDATA_API_KEY=xxx node scripts/discover.mjs <キーワード>");
  process.exit(1);
}

const bd = JSON.parse(readFileSync(join(ROOT, "config/brightdata.json"), "utf8"));
const HEADERS = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Instagramのユーザー名として無効なパス
const RESERVED = new Set(["p", "reel", "reels", "explore", "tags", "stories", "tv",
  "accounts", "about", "developer", "directory", "legal", "web", "api", "blog", "press"]);

function extractNames(text, names) {
  for (const m of text.matchAll(/instagram\.com\/([a-zA-Z0-9._]{3,30})/g)) {
    const name = m[1].replace(/\.+$/, "");
    if (!RESERVED.has(name.toLowerCase())) names.add(name);
  }
}

async function searchCandidates(kw) {
  // デバッグ用: 検索ステップを飛ばして候補を直接指定
  if (process.env.DISCOVER_TEST_CANDIDATES) {
    return process.env.DISCOVER_TEST_CANDIDATES.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const names = new Set();
  const CSE_KEY = process.env.GOOGLE_CSE_KEY;
  const CSE_CX = process.env.GOOGLE_CSE_CX;

  if (CSE_KEY && CSE_CX) {
    // 本命: Google Custom Search JSON API (無料100回/日)
    for (const start of [1, 11]) {
      const u = `https://www.googleapis.com/customsearch/v1?key=${CSE_KEY}&cx=${CSE_CX}` +
        `&q=${encodeURIComponent(`site:instagram.com ${kw}`)}&num=10&start=${start}&gl=jp&hl=ja`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Google検索APIエラー (HTTP ${r.status}): ${(await r.text()).slice(0, 150)}`);
      const j = await r.json();
      for (const item of j.items ?? []) extractNames(item.link ?? "", names);
      if (!j.queries?.nextPage) break;
    }
  } else {
    // 予備: DuckDuckGo (bot検知で失敗することがある)
    console.log("GOOGLE_CSE_KEY未設定のためDuckDuckGoで検索します(不安定な場合があります)");
    const q = encodeURIComponent(`site:instagram.com ${kw}`);
    const { stdout: html } = await run("curl", [
      "-s", `https://lite.duckduckgo.com/lite/?q=${q}`,
      "-H", `User-Agent: ${UA}`,
    ], { maxBuffer: 10 * 1024 * 1024 });
    extractNames(html, names);
  }
  return [...names].slice(0, 15);
}

async function triggerAndWait(datasetId, inputs) {
  const url = `${bd.api_base}/trigger?dataset_id=${datasetId}&include_errors=true`;
  const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(inputs) });
  if (!res.ok) throw new Error(`trigger失敗 ${res.status}: ${await res.text()}`);
  const { snapshot_id } = await res.json();
  console.log(`snapshot ${snapshot_id} を待機中...`);

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const prog = await fetch(`${bd.api_base}/progress/${snapshot_id}`, { headers: HEADERS });
    const { status } = await prog.json();
    if (status === "ready") break;
    if (status === "failed") throw new Error(`snapshot ${snapshot_id} が失敗しました`);
    if (i === 119) throw new Error("タイムアウト(20分)");
  }
  for (let i = 0; i < 30; i++) {
    const data = await fetch(`${bd.api_base}/snapshot/${snapshot_id}?format=json`, { headers: HEADERS });
    if (data.status === 202) { await new Promise((r) => setTimeout(r, 5_000)); continue; }
    if (!data.ok) throw new Error(`snapshot取得失敗 ${data.status}: ${await data.text()}`);
    const body = await data.json();
    if (Array.isArray(body)) return body;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("snapshotのダウンロードがタイムアウトしました");
}

console.log(`「${keyword}」でアカウント候補を検索中...`);
const candidates = await searchCandidates(keyword);
if (candidates.length === 0) {
  console.error("候補が見つかりませんでした。キーワードを変えてお試しください");
  process.exit(1);
}
console.log(`候補 ${candidates.length}件: ${candidates.join(", ")}`);

console.log("各候補のプロフィールを取得中...");
const inputs = candidates.map((u) => ({ url: `https://www.instagram.com/${u}/` }));
const profiles = await triggerAndWait(bd.datasets.profiles, inputs);

const accounts = profiles
  .filter((p) => p.account && !p.error)
  .map((p) => ({
    account: p.account,
    followers: p.followers ?? null,
    avg_engagement: p.avg_engagement ?? null,
    posts_count: p.posts_count ?? null,
    biography: (p.biography ?? "").slice(0, 120),
    is_verified: p.is_verified ?? false,
  }))
  .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));

const now = new Date();
const slug = `s_${now.getTime()}`;
const dir = join(ROOT, "data", "discover");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${slug}.json`), JSON.stringify({
  keyword, slug, date: now.toISOString().slice(0, 10), accounts,
}, null, 2));

const indexPath = join(dir, "index.json");
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
index.unshift({ slug, keyword, date: now.toISOString().slice(0, 10), count: accounts.length });
writeFileSync(indexPath, JSON.stringify(index.slice(0, 50), null, 2));

console.log(`完了: ${accounts.length}アカウントを発掘 → data/discover/${slug}.json`);
