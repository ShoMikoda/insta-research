#!/usr/bin/env node
// GitHub Actionsの環境から、各検索エンジンがInstagramアカウントを返せるか診断する。
// Bright Dataは使わない。結果をログ出力するだけ。

const kw = "スニーカー";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const q = `site:instagram.com ${kw}`;

function names(html) {
  const s = new Set();
  for (const m of html.matchAll(/instagram\.com\/([a-zA-Z0-9._]{3,30})/g)) s.add(m[1].replace(/\.+$/, ""));
  return [...s].slice(0, 10);
}

const targets = [
  ["duckduckgo-html", `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`],
  ["duckduckgo-lite", `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`],
  ["bing", `https://www.bing.com/search?q=${encodeURIComponent(q)}`],
  ["mojeek", `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`],
  ["startpage", `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`],
  ["brave", `https://search.brave.com/search?q=${encodeURIComponent(q)}`],
  ["ecosia", `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`],
  ["searx-be", `https://searx.be/search?q=${encodeURIComponent(q)}&format=json`],
];

for (const [name, url] of targets) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.9", "Accept": "text/html" },
      redirect: "follow",
    });
    const body = await r.text();
    const found = names(body);
    console.log(`[${name}] HTTP ${r.status} len=${body.length} accounts=${found.length} :: ${found.join(", ")}`);
  } catch (e) {
    console.log(`[${name}] ERROR ${e.message}`);
  }
}
