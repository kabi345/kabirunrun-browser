const ADMIN_SECRET = "115638";
const USER_PREFIX = "user:";
const USER_INDEX_KEY = "users:index:v1";

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
    error: "Cloudflare Pagesの設定が必要です。Pages Functionsに「DB」という名前でWorkers KV Namespaceをバインドしてください。"
  }, 500);
}

function databaseFailure(error, operation) {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error || "Unknown error");
  console.error(`Auth database operation failed (${operation})`, error);
  return json({
    error: `KVの${operation}処理に失敗しました。詳細: ${detail.slice(0, 300)}`
  }, 500);
}

function isListLimitError(error) {
  return /list\(\).*limit exceeded/i.test(String(error?.message || error));
}

// The first admin list request migrates existing user:* keys into a compact index.
// Subsequent admin refreshes read the index with get(), avoiding repeated KV list() calls.
async function getUserIds(env) {
  let index = await env.DB.get(USER_INDEX_KEY, "json");
  if (index?.version === 1 && index.complete === true && Array.isArray(index.ids)) {
    return [...new Set(index.ids.filter(id => typeof id === "string" && id))];
  }

  const ids = new Set(Array.isArray(index?.ids) ? index.ids.filter(id => typeof id === "string" && id) : []);
  let cursor;
  do {
    const page = await env.DB.list({ prefix: USER_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys || []) {
      const id = key.name.slice(USER_PREFIX.length);
      if (id) ids.add(id);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const completeIndex = { version: 1, complete: true, ids: [...ids] };
  await env.DB.put(USER_INDEX_KEY, JSON.stringify(completeIndex));
  return completeIndex.ids;
}

async function addUserIdToIndex(env, id) {
  const index = await env.DB.get(USER_INDEX_KEY, "json");
  const ids = new Set(Array.isArray(index?.ids) ? index.ids : []);
  ids.add(id);
  // Do not call a partial index complete: legacy users still need one migration list.
  await env.DB.put(USER_INDEX_KEY, JSON.stringify({
    version: 1,
    complete: index?.version === 1 && index.complete === true,
    ids: [...ids]
  }));
}

async function removeUserIdFromIndex(env, id) {
  const index = await env.DB.get(USER_INDEX_KEY, "json");
  if (!index || !Array.isArray(index.ids)) return;
  index.ids = index.ids.filter(existingId => existingId !== id);
  await env.DB.put(USER_INDEX_KEY, JSON.stringify(index));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "health") return json({ ok: true, api: "auth" });
  if (action !== "list") return json({ error: "Invalid action" }, 400);
  if (!checkAdmin(url.searchParams.get("adminKey"))) {
    return json({ error: "管理者権限がありません。" }, 403);
  }
  if (!hasKvBinding(env)) return databaseUnavailable();

  try {
    const ids = await getUserIds(env);
    const users = await Promise.all(ids.map(id => env.DB.get(USER_PREFIX + id, "json")));
    const filteredUsers = users.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ users: filteredUsers });
  } catch (error) {
    if (isListLimitError(error)) {
      return json({
        error: "Cloudflare Workers KVのlist()上限に達しています。既存アカウント一覧の初回移行が完了できませんでした。上限が回復した後に管理者パネルを一度開けば一覧を索引化し、以降はlist()を繰り返し呼びません。"
      }, 503);
    }
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

      const existing = await env.DB.get(USER_PREFIX + id, "json");
      if (existing) {
        return json({ error: "このIDはすでに使われています。別のIDにしてください。" }, 409);
      }

      await env.DB.put(USER_PREFIX + id, JSON.stringify({
        id,
        password,
        status: "pending",
        createdAt: Date.now()
      }));
      await addUserIdToIndex(env, id);

      return json({
        ok: true,
        message: "アカウント申請を送信しました！管理者の許可をお待ちください。",
        status: "pending"
      });
    }

    if (action === "login") {
      const id = String(body.id || "").trim();
      const password = String(body.password || "").trim();
      if (!id || !password) return json({ error: "IDとパスワードを入力してください。" }, 400);

      const user = await env.DB.get(USER_PREFIX + id, "json");
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
        await env.DB.delete(USER_PREFIX + targetId);
        await removeUserIdFromIndex(env, targetId);
        return json({ ok: true });
      }

      const user = await env.DB.get(USER_PREFIX + targetId, "json");
      if (!user) return json({ error: "ユーザーが見つかりません。" }, 404);
      user.status = decision;
      await env.DB.put(USER_PREFIX + targetId, JSON.stringify(user));
      return json({ ok: true, user });
    }

    return json({ error: "Invalid action" }, 400);
  } catch (error) {
    console.error(`Auth ${action || "unknown"} failed`, error);
    return databaseFailure(error, action || "unknown");
  }
}
