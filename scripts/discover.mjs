#!/usr/bin/env node
// キーワードからInstagramアカウントを発掘する。
// DuckDuckGoで「site:instagram.com <キーワード>」を検索して候補を集め、
// Bright Data Profilesスクレイパーで詳細(フォロワー数等)を取得してランキング化。
// 使い方: BRIGHTDATA_API_KEY=xxx node scripts/discover.mjs "スニーカー"

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = process.env.BRIGHTDATA_API_KEY;
const keyword = process.argv[2]?.trim();
if (!API_KEY || !keyword) {
  console.error("使い方: BRIGHTDATA_API_KEY=xxx node scripts/discover.mjs <キーワード>");
  process.exit(1);
}

const bd = JSON.parse(readFileSync(join(ROOT, "config/brightdata.json"), "utf8"));
const HEADERS = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Instagramのユーザー名として無効なパス
const RESERVED = new Set(["p", "reel", "reels", "explore", "tags", "stories", "tv",
  "accounts", "about", "developer", "directory", "legal", "web", "api", "blog", "press"]);

function extractNames(text, names) {
  for (const m of text.matchAll(/instagram\.com\/([a-zA-Z0-9._]{3,30})/g)) {
    const name = m[1].replace(/\.+$/, "");
    if (!RESERVED.has(name.toLowerCase())) names.add(name);
  }
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.9", "Accept": "text/html" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function searchCandidates(kw) {
  // デバッグ用: 検索ステップを飛ばして候補を直接指定
  if (process.env.DISCOVER_TEST_CANDIDATES) {
    return process.env.DISCOVER_TEST_CANDIDATES.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const q = `site:instagram.com ${kw}`;
  // 複数の無料検索エンジンの結果を統合して候補を増やす(GitHub Actionsから動作確認済み)
  const engines = [
    ["DuckDuckGo", `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`],
    ["Brave", `https://search.brave.com/search?q=${encodeURIComponent(q)}`],
    ["DuckDuckGo(lite)", `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`],
  ];
  const names = new Set();
  for (const [name, url] of engines) {
    if (names.size >= 20) break;
    try {
      const before = names.size;
      extractNames(await fetchText(url), names);
      console.log(`検索エンジン ${name}: +${names.size - before}件 (計${names.size}件)`);
    } catch (e) {
      console.log(`${name} は失敗(${e.message})、次を試します`);
    }
  }
  return [...names].slice(0, 20);
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
    // バズ投稿TOP3(直近投稿のいいね順・追加コストなし)
    top_posts: (p.posts ?? [])
      .filter((x) => x.likes != null)
      .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
      .slice(0, 3)
      .map((x) => ({
        caption: (x.caption ?? "").slice(0, 90),
        likes: x.likes,
        comments: x.comments ?? null,
        url: x.url,
        date: (x.datetime ?? "").slice(0, 10),
        is_video: x.content_type === "Video",
      })),
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
