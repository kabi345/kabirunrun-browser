function checkAdmin(key) {
  const clean = String(key || "").replace(/[×x]/g, "*").replace(/\s/g, "");
  return clean === "115638" || clean === "114514+810+314";
}

async function verifyUser(env, id, password) {
  if (id === "admin" && checkAdmin(password)) {
    return { id: "admin", status: "approved" };
  }
  const user = await env.DB.get("user:" + id, "json");
  if (!user || user.password !== password) return null;
  if (user.status !== "approved") return null;
  return user;
}

function roomKey(a, b) {
  const pair = [a, b].sort();
  return "chat:" + pair[0] + ":" + pair[1];
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "KVバインディング(DB)が設定されていません。" }, { status: 500 });
  }
  const url = new URL(request.url);
  const me = (url.searchParams.get("me") || "").trim();
  const password = (url.searchParams.get("password") || "").trim();
  const peer = (url.searchParams.get("peer") || "").trim();

  const auth = await verifyUser(env, me, password);
  if (!auth) {
    return Response.json({ error: "認証に失敗しました。許可済みのIDとパスワードでログインしてください。" }, { status: 403 });
  }

  // Return list of approved users so users can see who is available to message
  const userList = await env.DB.list({ prefix: "user:" });
  const approvedUsers = ["admin"];
  for (const k of userList.keys) {
    const u = await env.DB.get(k.name, "json");
    if (u && u.status === "approved" && u.id !== me) {
      approvedUsers.push(u.id);
    }
  }
  const partners = approvedUsers.filter(x => x !== me);

  if (!peer) {
    return Response.json({ ok: true, partners, messages: [] });
  }

  const key = roomKey(me, peer);
  const messages = (await env.DB.get(key, "json")) || [];
  return Response.json({ ok: true, partners, messages });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "KVバインディング(DB)が設定されていません。" }, { status: 500 });
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "不正なリクエストです。" }, { status: 400 });
  }

  const me = String(body.me || "").trim();
  const password = String(body.password || "").trim();
  const peer = String(body.peer || "").trim();
  const text = String(body.text || "").trim().slice(0, 500);

  const auth = await verifyUser(env, me, password);
  if (!auth) {
    return Response.json({ error: "認証に失敗しました。" }, { status: 403 });
  }
  if (!peer || !text) {
    return Response.json({ error: "送信先IDとメッセージを入力してください。" }, { status: 400 });
  }

  // Check that peer exists (either admin or an existing user)
  if (peer !== "admin") {
    const peerUser = await env.DB.get("user:" + peer, "json");
    if (!peerUser) {
      return Response.json({ error: "指定されたIDのユーザーが見つかりません。" }, { status: 404 });
    }
  }

  const key = roomKey(me, peer);
  const messages = (await env.DB.get(key, "json")) || [];
  messages.push({
    from: me,
    to: peer,
    text,
    at: Date.now()
  });
  // Keep latest 100 messages per pair
  const trimmed = messages.slice(-100);
  await env.DB.put(key, JSON.stringify(trimmed));

  return Response.json({ ok: true, messages: trimmed });
}
