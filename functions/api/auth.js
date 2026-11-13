const ADMIN_SECRET = "115638";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function checkAdmin(key) {
  const clean = String(key || "").trim().replace(/[×x]/g, "*").replace(/\s/g, "");
  return clean === ADMIN_SECRET || clean === "114514+810+314";
}

function hasKvBinding(env) {
  return env.DB &&
    typeof env.DB.get === "function" &&
    typeof env.DB.put === "function" &&
    typeof env.DB.delete === "function" &&
    typeof env.DB.list === "function";
}

function databaseUnavailable() {
  return json({
    error: "Cloudflare Pagesの設定が必要です。Pages Functionsに「DB」という名前でKV Namespaceをバインドしてください（D1ではなくWorkers KVです）。"
  }, 500);
}

function databaseFailure(error, operation) {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error || "Unknown error");
  console.error(`Auth database operation failed (${operation})`, error);
  return json({
    error: `KVの${operation}処理に失敗しました。Pagesの「DB」KV Namespace設定と本番環境へのバインドを確認してください。詳細: ${detail.slice(0, 300)}`
  }, 500);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "health") {
    return json({ ok: true, api: "auth" });
  }
  if (action !== "list") {
    return json({ error: "Invalid action" }, 400);
  }
  if (!checkAdmin(url.searchParams.get("adminKey"))) {
    return json({ error: "管理者権限がありません。" }, 403);
  }
  if (!hasKvBinding(env)) {
    return databaseUnavailable();
  }

  try {
    const result = await env.DB.list({ prefix: "user:" });
    const users = await Promise.all(result.keys.map(key => env.DB.get(key.name, "json")));
    const filteredUsers = users.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ users: filteredUsers });
  } catch (error) {
    return databaseFailure(error, "list/get");
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "不正なリクエストです。JSON形式で送信してください。" }, 400);
  }

  if (action === "decide" && !checkAdmin(body.adminKey)) {
    return json({ error: "管理者権限がありません。" }, 403);
  }
  if (["register", "login", "decide"].includes(action) && !hasKvBinding(env)) {
    return databaseUnavailable();
  }

  try {
    if (action === "register") {
      const id = String(body.id || "").trim();
      const password = String(body.password || "").trim();
      if (!/^[a-zA-Z0-9_-]{2,24}$/.test(id)) {
        return json({ error: "IDは半角英数字・ハイフン・アンダースコアで2〜24文字にしてください。" }, 400);
      }
      if (password.length < 3 || password.length > 40) {
        return json({ error: "パスワードは3〜40文字で設定してください。" }, 400);
      }
      if (id.toLowerCase() === "admin") {
        return json({ error: "このIDは使用できません。" }, 400);
      }

      const existing = await env.DB.get("user:" + id, "json");
      if (existing) {
        return json({ error: "このIDはすでに使われています。別のIDにしてください。" }, 409);
      }

      await env.DB.put("user:" + id, JSON.stringify({
        id,
        password,
        status: "pending",
        createdAt: Date.now()
      }));

      return json({
        ok: true,
        message: "アカウント申請を送信しました！管理者の許可をお待ちください。",
        status: "pending"
      });
    }

    if (action === "login") {
      const id = String(body.id || "").trim();
      const password = String(body.password || "").trim();
      if (!id || !password) {
        return json({ error: "IDとパスワードを入力してください。" }, 400);
      }

      const user = await env.DB.get("user:" + id, "json");
      if (!user || user.password !== password) {
        return json({ error: "IDまたはパスワードが違います。" }, 401);
      }
      if (user.status !== "approved") {
        const status = user.status === "rejected" ? "rejected" : "pending";
        return json({
          ok: false,
          error: status === "rejected"
            ? "このアカウントは管理者により拒否されています。"
            : "このアカウントはまだ管理者の許可待ちです。",
          status
        }, 403);
      }

      return json({ ok: true, id: user.id, status: user.status });
    }

    if (action === "decide") {
      const targetId = String(body.id || "").trim();
      const decision = String(body.decision || "").trim();
      if (!targetId) return json({ error: "対象IDがありません。" }, 400);
      if (!["approved", "rejected", "delete"].includes(decision)) {
        return json({ error: "不正な操作です。" }, 400);
      }

      if (decision === "delete") {
        await env.DB.delete("user:" + targetId);
        return json({ ok: true });
      }

      const user = await env.DB.get("user:" + targetId, "json");
      if (!user) return json({ error: "ユーザーが見つかりません。" }, 404);
      user.status = decision;
      await env.DB.put("user:" + targetId, JSON.stringify(user));
      return json({ ok: true, user });
    }

    return json({ error: "Invalid action" }, 400);
  } catch (error) {
    if (action === "decide") {
      return databaseFailure(error, "get/put/delete");
    }
    console.error(`Auth ${action || "unknown"} failed`, error);
    return json({ error: "認証データベースの処理に失敗しました。Cloudflare PagesのKV設定を確認してください。" }, 500);
  }
}
