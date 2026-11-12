export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 160);
  if (!query) return Response.json({ results: [] }, { status: 400 });
  // Search results only; this endpoint is not a general-purpose proxy.
  const endpoint = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const upstream = await fetch(endpoint, {headers:{"Accept":"text/html,application/xhtml+xml","Accept-Language":"ja,en;q=0.8"}});
  if (!upstream.ok) return Response.json({error:"Search provider unavailable"},{status:502});
  const page = await upstream.text();
  const results = [];
  function decodeEntities(v){return v.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x2F;/g,"/");}
  const links = [...page.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of links) {
    if(results.length>=10)break;
    try {
      let target=decodeEntities(m[1]);if(target.startsWith("//"))target="https:"+target;
      const parsed=new URL(target);const redirected=parsed.searchParams.get("uddg");if(redirected)target=redirected;
      const finalUrl=new URL(target);if(!["http:","https:"].includes(finalUrl.protocol))continue;
      const title=decodeEntities(m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ")).trim();
      const after=page.slice(m.index+m[0].length,m.index+m[0].length+1800);
      const sm=after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
      const snippet=sm?decodeEntities(sm[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ")).trim():"";
      results.push({title:title||finalUrl.hostname,url:finalUrl.href,displayUrl:finalUrl.hostname,snippet});
    } catch { continue; }
  }
  return Response.json({results},{headers:{"Cache-Control":"public, max-age=60"}});
}
