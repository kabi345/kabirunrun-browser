const ADMIN_SECRET = "115638";

function checkAdmin(key) {
  const clean = String(key || "").replace(/[×x]/g, "*").replace(/\s/g, "");
  return clean === "115638" || clean === "114514+810+314";
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "KVバインディング(DB)が設定されていません。" }, { status: 500 });
  }
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "list") {
    const adminKey = url.searchParams.get("adminKey");
    if (!checkAdmin(adminKey)) {
      return Response.json({ error: "管理者権限がありません。" }, { status: 403 });
    }
    const list = await env.DB.list({ prefix: "user:" });
    const users = [];
    for (const k of list.keys) {
      const val = await env.DB.get(k.name, "json");
      if (val) users.push(val);
    }
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return Response.json({ users });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "KVバインディング(DB)が設定されていません。" }, { status: 500 });
  }
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "不正なリクエストです。" }, { status: 400 });
  }

  if (action === "register") {
    const id = String(body.id || "").trim();
    const password = String(body.password || "").trim();
    if (!/^[a-zA-Z0-9_-]{2,24}$/.test(id)) {
      return Response.json({ error: "IDは半角英数字・ハイフン・アンダースコアで2〜24文字にしてください。" }, { status: 400 });
    }
    if (password.length < 3 || password.length > 40) {
      return Response.json({ error: "パスワードは3〜40文字で設定してください。" }, { status: 400 });
    }
    if (id.toLowerCase() === "admin") {
      return Response.json({ error: "このIDは使用できません。" }, { status: 400 });
    }
    const existing = await env.DB.get("user:" + id, "json");
    if (existing) {
      return Response.json({ error: "このIDはすでに使われています。別のIDにしてください。" }, { status: 409 });
    }
    const userObj = {
      id,
      password,
      status: "pending", // pending | approved | rejected
      createdAt: Date.now()
    };
    await env.DB.put("user:" + id, JSON.stringify(userObj));
    return Response.json({
      ok: true,
      message: "アカウント申請を送信しました！管理者の許可をお待ちください。",
      status: "pending"
    });
  }

  if (action === "login") {
    const id = String(body.id || "").trim();
    const password = String(body.password || "").trim();
    if (!id || !password) {
      return Response.json({ error: "IDとパスワードを入力してください。" }, { status: 400 });
    }
    const user = await env.DB.get("user:" + id, "json");
    if (!user || user.password !== password) {
      return Response.json({ error: "IDまたはパスワードが違います。" }, { status: 401 });
    }
    return Response.json({
      ok: true,
      id: user.id,
      status: user.status
    });
  }

  if (action === "decide") {
    if (!checkAdmin(body.adminKey)) {
      return Response.json({ error: "管理者権限がありません。" }, { status: 403 });
    }
    const targetId = String(body.id || "").trim();
    const decision = String(body.decision || "").trim(); // approved | rejected | delete
    if (!targetId) return Response.json({ error: "対象IDがありません。" }, { status: 400 });

    if (decision === "delete") {
      await env.DB.delete("user:" + targetId);
      return Response.json({ ok: true });
    }

    const user = await env.DB.get("user:" + targetId, "json");
    if (!user) return Response.json({ error: "ユーザーが見つかりません。" }, { status: 404 });
    user.status = decision === "approved" ? "approved" : "rejected";
    await env.DB.put("user:" + targetId, JSON.stringify(user));
    return Response.json({ ok: true, user });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
