#!/usr/bin/env node
// Bright Data Instagram Scraper APIで各カテゴリのウォッチリストを収集し、
// data/<カテゴリID>/ 配下に日次スナップショットと履歴を保存する。
// 使い方: BRIGHTDATA_API_KEY=xxx node scripts/collect.mjs [カテゴリID]
//   カテゴリID省略時は全カテゴリを収集

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = process.env.BRIGHTDATA_API_KEY;
if (!API_KEY) {
  console.error("環境変数 BRIGHTDATA_API_KEY が設定されていません");
  process.exit(1);
}

const bd = JSON.parse(readFileSync(join(ROOT, "config/brightdata.json"), "utf8"));
const { categories } = JSON.parse(readFileSync(join(ROOT, "config/categories.json"), "utf8"));
const HEADERS = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

const onlyId = process.argv[2];
const targets = onlyId ? categories.filter((c) => c.id === onlyId) : categories;
if (targets.length === 0) {
  console.error(`カテゴリ "${onlyId}" が config/categories.json に見つかりません`);
  process.exit(1);
}

async function triggerAndWait(datasetId, inputs, extraParams = "") {
  const url = `${bd.api_base}/trigger?dataset_id=${datasetId}&include_errors=true${extraParams}`;
  const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(inputs) });
  if (!res.ok) throw new Error(`trigger失敗 ${res.status}: ${await res.text()}`);
  const { snapshot_id } = await res.json();
  console.log(`  snapshot ${snapshot_id} を待機中...`);

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const prog = await fetch(`${bd.api_base}/progress/${snapshot_id}`, { headers: HEADERS });
    const { status } = await prog.json();
    if (status === "ready") break;
    if (status === "failed") throw new Error(`snapshot ${snapshot_id} が失敗しました`);
    if (i === 119) throw new Error("タイムアウト(20分)");
  }

  // ready直後は202(準備中)が返ることがあるため、配列が返るまでリトライ
  for (let i = 0; i < 30; i++) {
    const data = await fetch(`${bd.api_base}/snapshot/${snapshot_id}?format=json`, { headers: HEADERS });
    if (data.status === 202) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (!data.ok) throw new Error(`snapshot取得失敗 ${data.status}: ${await data.text()}`);
    const body = await data.json();
    if (Array.isArray(body)) return body;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("snapshotのダウンロードがタイムアウトしました");
}

const today = new Date().toISOString().slice(0, 10);

for (const cat of targets) {
  const accounts = cat.accounts.filter((a) => !a.startsWith("REPLACE_ME"));
  if (accounts.length === 0) {
    console.log(`[${cat.name}] アカウント未登録のためスキップ`);
    continue;
  }

  console.log(`[${cat.name}] ${accounts.length}アカウントを収集します (${today})`);
  const inputs = accounts.map((u) => ({ url: `https://www.instagram.com/${u}/` }));
  const profiles = await triggerAndWait(bd.datasets.profiles, inputs);

  // 各アカウントの最新リール(10件ずつ)を発見モードで収集
  console.log(`[${cat.name}] リールを収集します`);
  const reelInputs = accounts.map((u) => ({
    url: `https://www.instagram.com/${u}/`,
    num_of_posts: 10,
  }));
  let reels = [];
  try {
    reels = await triggerAndWait(bd.datasets.reels, reelInputs, "&type=discover_new&discover_by=url");
  } catch (e) {
    console.error(`  リール収集に失敗(プロフィールのみ保存します): ${e.message}`);
  }

  const catDir = join(ROOT, "data", cat.id);
  const dayDir = join(catDir, today);
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, "profiles.json"), JSON.stringify(profiles, null, 2));
  writeFileSync(join(dayDir, "reels.json"), JSON.stringify(reels, null, 2));

  // 履歴(アカウント×日付のフォロワー数等)を更新
  const historyPath = join(catDir, "history.json");
  const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : {};
  for (const p of profiles) {
    const name = p.account ?? p.username ?? p.profile_name;
    if (!name) continue;
    history[name] ??= {};
    history[name][today] = {
      followers: p.followers ?? p.followers_count ?? null,
      posts: p.posts_count ?? null,
      avg_engagement: p.avg_engagement ?? null,
    };
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));

  // ダッシュボード用の最新データ(リールは表示に使う項目だけに絞って軽量化)
  const reelsSlim = reels.filter((r) => r.user_posted && !r.error).map((r) => ({
    account: r.user_posted,
    url: r.url,
    description: r.description,
    likes: r.likes,
    comments: r.num_comments,
    plays: r.video_play_count ?? r.views ?? null,
    length: r.length,
    date: r.date_posted,
  }));
  writeFileSync(
    join(catDir, "latest.json"),
    JSON.stringify({ date: today, category: cat.id, name: cat.name, profiles, reels: reelsSlim, history }, null, 2)
  );
  console.log(`  完了: data/${cat.id}/ を更新しました`);
}
console.log("すべてのカテゴリの収集が完了しました");
