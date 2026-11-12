function decodeEntities(v) {
  return v
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim();
}

function extractRealUrl(rawHref) {
  let target = decodeEntities(rawHref);
  if (target.startsWith("//")) target = "https:" + target;
  if (target.startsWith("/l/?")) target = "https://duckduckgo.com" + target;
  const parsed = new URL(target);
  // DuckDuckGoのリダイレクトパラメータ（uddg）から本当のURLを取り出す
  const redirected = parsed.searchParams.get("uddg");
  if (redirected) target = redirected;
  // 広告リンク（duckduckgo.com/y.js など）を除外
  if (target.includes("duckduckgo.com/y.js") || target.includes("bing.com/aclick")) {
    return null;
  }
  const finalUrl = new URL(target);
  if (!["http:", "https:"].includes(finalUrl.protocol)) return null;
  return finalUrl;
}

function parseDdgHtml(page) {
  const results = [];
  // 広告ブロック（result--ad）を除外するため、各結果ブロック単位で解析
  const blocks = page.split(/<div[^>]*class="[^"]*result\s+results_links[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 12) break;
    if (/result--ad/i.test(block.slice(0, 120))) continue;
    try {
      const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;
      const finalUrl = extractRealUrl(linkMatch[1]);
      if (!finalUrl) continue;
      const title = cleanText(linkMatch[2]);
      const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
      const snippet = snippetMatch ? cleanText(snippetMatch[1]) : "";
      results.push({
        title: title || finalUrl.hostname,
        url: finalUrl.href,
        displayUrl: finalUrl.hostname + (finalUrl.pathname !== "/" ? finalUrl.pathname : ""),
        snippet
      });
    } catch {
      continue;
    }
  }
  return results;
}

function parseDdgLite(page) {
  const results = [];
  const links = [...page.matchAll(/<a[^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of links) {
    if (results.length >= 12) break;
    try {
      const finalUrl = extractRealUrl(m[1]);
      if (!finalUrl) continue;
      const title = cleanText(m[2]);
      const after = page.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      const sm = after.match(/class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i);
      const snippet = sm ? cleanText(sm[1]) : "";
      results.push({
        title: title || finalUrl.hostname,
        url: finalUrl.href,
        displayUrl: finalUrl.hostname + (finalUrl.pathname !== "/" ? finalUrl.pathname : ""),
        snippet
      });
    } catch {
      continue;
    }
  }
  return results;
}

function parseYahooJapan(page) {
  const results = [];
  const blocks = page.split(/<div[^>]*class="[^"]*sw-CardBase[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 12) break;
    try {
      const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;
      let href = decodeEntities(linkMatch[1]);
      if (href.includes("yahoo.co.jp/search") || href.includes("rdsig.yahoo.co.jp")) continue;
      const finalUrl = new URL(href);
      const title = cleanText(linkMatch[2]);
      if (!title || title.length < 2) continue;
      const snippetMatch = block.match(/<p[^>]*class="[^"]*sw-Card__summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snippetMatch ? cleanText(snippetMatch[1]) : "";
      results.push({
        title,
        url: finalUrl.href,
        displayUrl: finalUrl.hostname + (finalUrl.pathname !== "/" ? finalUrl.pathname : ""),
        snippet
      });
    } catch {
      continue;
    }
  }
  return results;
}

async function fetchWithTimeout(url, options, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchDdgHtml(query) {
  const endpoint = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=jp-jp";
  const res = await fetchWithTimeout(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    }
  }, 6000);
  if (!res.ok) throw new Error("ddg-html-failed");
  const text = await res.text();
  const items = parseDdgHtml(text);
  if (!items.length) throw new Error("ddg-html-empty");
  return items;
}

async function searchDdgLite(query) {
  const endpoint = "https://lite.duckduckgo.com/lite/";
  const body = "q=" + encodeURIComponent(query) + "&kl=jp-jp";
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    },
    body
  }, 6000);
  if (!res.ok) throw new Error("ddg-lite-failed");
  const text = await res.text();
  const items = parseDdgLite(text);
  if (!items.length) throw new Error("ddg-lite-empty");
  return items;
}

async function searchYahooJapan(query) {
  const endpoint = "https://search.yahoo.co.jp/search?p=" + encodeURIComponent(query) + "&ei=UTF-8";
  const res = await fetchWithTimeout(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    }
  }, 6000);
  if (!res.ok) throw new Error("yahoo-failed");
  const text = await res.text();
  const items = parseYahooJapan(text);
  if (!items.length) throw new Error("yahoo-empty");
  return items;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 160);
  if (!query) return Response.json({ results: [] }, { status: 400 });

  let results = [];
  try {
    // 通常のWeb検索（DuckDuckGo HTML / Lite / Yahoo!検索）を並列で実行し、普通のWeb検索結果だけを返す
    results = await Promise.any([
      searchDdgHtml(query),
      searchDdgLite(query),
      searchYahooJapan(query)
    ]);
  } catch {
    return Response.json(
      { error: "検索結果を取得できませんでした。少し待ってからもう一度お試しください。", results: [] },
      { status: 502 }
    );
  }

  return Response.json(
    { results },
    {
      headers: {
        "Cache-Control": "public, max-age=180",
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}
