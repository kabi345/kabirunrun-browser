function decodeEntities(v) {
  return v
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
}

function parseDdgHtml(page) {
  const results = [];
  const links = [...page.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of links) {
    if (results.length >= 12) break;
    try {
      let target = decodeEntities(m[1]);
      if (target.startsWith("//")) target = "https:" + target;
      const parsed = new URL(target);
      const redirected = parsed.searchParams.get("uddg");
      if (redirected) target = redirected;
      const finalUrl = new URL(target);
      if (!["http:", "https:"].includes(finalUrl.protocol)) continue;

      const title = decodeEntities(m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim();
      const after = page.slice(m.index + m[0].length, m.index + m[0].length + 2000);
      const sm = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
      const snippet = sm ? decodeEntities(sm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim() : "";

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
      let target = decodeEntities(m[1]);
      if (target.startsWith("//")) target = "https:" + target;
      const parsed = new URL(target);
      const redirected = parsed.searchParams.get("uddg");
      if (redirected) target = redirected;
      const finalUrl = new URL(target);
      if (!["http:", "https:"].includes(finalUrl.protocol)) continue;

      const title = decodeEntities(m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim();
      const after = page.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      const sm = after.match(/class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i);
      const snippet = sm ? decodeEntities(sm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim() : "";

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

async function fetchWithTimeout(url, options, ms = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function searchDdgHtml(query) {
  const endpoint = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=jp-jp";
  const res = await fetchWithTimeout(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.8"
    }
  }, 3500);
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html",
      "Accept-Language": "ja,en;q=0.8"
    },
    body
  }, 3500);
  if (!res.ok) throw new Error("ddg-lite-failed");
  const text = await res.text();
  const items = parseDdgLite(text);
  if (!items.length) throw new Error("ddg-lite-empty");
  return items;
}

async function searchWikipediaFallback(query) {
  const endpoint = "https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=" + encodeURIComponent(query) + "&format=json&utf8=1&srlimit=8";
  const res = await fetchWithTimeout(endpoint, {
    headers: { "Accept": "application/json", "User-Agent": "KabirunrunBrowser/1.0" }
  }, 3000);
  if (!res.ok) return [];
  const data = await res.json();
  const list = data?.query?.search || [];
  return list.map(item => {
    const pageUrl = "https://ja.wikipedia.org/wiki/" + encodeURIComponent(item.title.replace(/ /g, "_"));
    const snippet = (item.snippet || "").replace(/<[^>]+>/g, "");
    return {
      title: item.title + " - Wikipedia",
      url: pageUrl,
      displayUrl: "ja.wikipedia.org/wiki/" + item.title,
      snippet
    };
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 160);
  if (!query) return Response.json({ results: [] }, { status: 400 });

  let results = [];
  try {
    // HTML版とLite版を同時にリクエストし、一番早く成功した結果を採用（体感速度を大幅アップ）
    results = await Promise.any([
      searchDdgHtml(query),
      searchDdgLite(query)
    ]);
  } catch {
    // 両方ともタイムアウトやレート制限で失敗した場合はWikipedia検索へ自動フォールバック
    try {
      results = await searchWikipediaFallback(query);
    } catch {
      results = [];
    }
  }

  return Response.json(
    { results },
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}
