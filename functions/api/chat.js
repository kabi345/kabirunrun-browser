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

function dmKey(a, b) {
  const sorted = [String(a), String(b)].sort();
  return "dm:" + sorted[0] + ":" + sorted[1];
}

async function getApprovedPartners(env, me) {
  const partners = new Set();
  if (me !== "admin") partners.add("admin");
  const list = await env.DB.list({ prefix: "user:" });
  for (const k of list.keys) {
    const u = await env.DB.get(k.name, "json");
    if (u && u.status === "approved" && u.id && u.id !== me) {
      partners.add(u.id);
    }
  }
  return Array.from(partners);
}

async function getUserGroups(env, me) {
  const groups = [];
  const list = await env.DB.list({ prefix: "group:" });
  for (const k of list.keys) {
    const g = await env.DB.get(k.name, "json");
    if (g && Array.isArray(g.members) && (g.members.includes(me) || me === "admin")) {
      groups.push({
        id: g.id,
        name: g.name,
        owner: g.owner,
        members: g.members
      });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return groups;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "KVバインディング(DB)が設定されていません。" }, { status: 500 });
  }
  const url = new URL(request.url);
  const me = (url.searchParams.get("me") || "").trim();
  const password = (url.searchParams.get("password") || "").trim();
  const peer = (url.searchParams.get("peer") || "").trim();
  const groupId = (url.searchParams.get("groupId") || "").trim();

  const auth = await verifyUser(env, me, password);
  if (!auth) {
    return Response.json({ error: "認証に失敗しました。" }, { status: 403 });
  }

  const partners = await getApprovedPartners(env, me);
  const groups = await getUserGroups(env, me);

  if (groupId) {
    const g = await env.DB.get("group:" + groupId, "json");
    if (!g || (!g.members.includes(me) && me !== "admin")) {
      return Response.json({ error: "このグループへのアクセス権がありません。" }, { status: 403 });
    }
    const messages = (await env.DB.get("groupmsg:" + groupId, "json")) || [];
    return Response.json({
      ok: true,
      partners,
      groups,
      group: g,
      messages: messages.slice(-100)
    });
  }

  let messages = [];
  if (peer) {
    messages = (await env.DB.get(dmKey(me, peer), "json")) || [];
  }

  return Response.json({
    ok: true,
    partners,
    groups,
    messages: messages.slice(-100)
  });
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
  const action = String(body.action || "send").trim();

  const auth = await verifyUser(env, me, password);
  if (!auth) {
    return Response.json({ error: "認証に失敗しました。" }, { status: 403 });
  }

  // 1. Create a new group chat
  if (action === "create_group") {
    const name = String(body.name || "").trim().slice(0, 30);
    const rawMembers = Array.isArray(body.members) ? body.members : [];
    if (!name) {
      return Response.json({ error: "グループ名を入力してください。" }, { status: 400 });
    }

    const memberSet = new Set([me]);
    for (const m of rawMembers) {
      const mid = String(m || "").trim();
      if (!mid) continue;
      if (mid === "admin") {
        memberSet.add("admin");
      } else {
        const u = await env.DB.get("user:" + mid, "json");
        if (u && u.status === "approved") {
          memberSet.add(mid);
        }
      }
    }

    const groupId = "grp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    const groupObj = {
      id: groupId,
      name,
      owner: me,
      members: Array.from(memberSet),
      createdAt: Date.now()
    };

    await env.DB.put("group:" + groupId, JSON.stringify(groupObj));
    await env.DB.put("groupmsg:" + groupId, JSON.stringify([
      { from: "SYSTEM", text: `${me} がグループ「${name}」を作成しました`, at: Date.now() }
    ]));

    const groups = await getUserGroups(env, me);
    return Response.json({ ok: true, group: groupObj, groups });
  }

  // 2. Add member to existing group
  if (action === "add_member") {
    const groupId = String(body.groupId || "").trim();
    const newMember = String(body.memberId || "").trim();
    const g = await env.DB.get("group:" + groupId, "json");
    if (!g || (!g.members.includes(me) && me !== "admin")) {
      return Response.json({ error: "グループが見つからないか権限がありません。" }, { status: 403 });
    }
    if (!newMember) {
      return Response.json({ error: "追加するIDを入力してください。" }, { status: 400 });
    }
    if (newMember !== "admin") {
      const u = await env.DB.get("user:" + newMember, "json");
      if (!u || u.status !== "approved") {
        return Response.json({ error: "そのIDは存在しないか、まだ承認されていません。" }, { status: 404 });
      }
    }
    if (!g.members.includes(newMember)) {
      g.members.push(newMember);
      await env.DB.put("group:" + groupId, JSON.stringify(g));
      const msgs = (await env.DB.get("groupmsg:" + groupId, "json")) || [];
      msgs.push({ from: "SYSTEM", text: `${me} が ${newMember} をグループに追加しました`, at: Date.now() });
      await env.DB.put("groupmsg:" + groupId, JSON.stringify(msgs.slice(-150)));
    }
    const messages = (await env.DB.get("groupmsg:" + groupId, "json")) || [];
    return Response.json({ ok: true, group: g, messages: messages.slice(-100) });
  }

  // 3. Leave group
  if (action === "leave_group") {
    const groupId = String(body.groupId || "").trim();
    const g = await env.DB.get("group:" + groupId, "json");
    if (!g || !g.members.includes(me)) {
      return Response.json({ error: "グループに参加していません。" }, { status: 400 });
    }
    g.members = g.members.filter(m => m !== me);
    if (g.members.length === 0) {
      await env.DB.delete("group:" + groupId);
      await env.DB.delete("groupmsg:" + groupId);
    } else {
      await env.DB.put("group:" + groupId, JSON.stringify(g));
      const msgs = (await env.DB.get("groupmsg:" + groupId, "json")) || [];
      msgs.push({ from: "SYSTEM", text: `${me} がグループから退出しました`, at: Date.now() });
      await env.DB.put("groupmsg:" + groupId, JSON.stringify(msgs.slice(-150)));
    }
    const groups = await getUserGroups(env, me);
    return Response.json({ ok: true, groups });
  }

  // 4. Send message (Group or DM)
  const text = String(body.text || "").trim().slice(0, 1000);
  if (!text) {
    return Response.json({ error: "メッセージを入力してください。" }, { status: 400 });
  }

  const groupId = String(body.groupId || "").trim();
  if (groupId) {
    const g = await env.DB.get("group:" + groupId, "json");
    if (!g || (!g.members.includes(me) && me !== "admin")) {
      return Response.json({ error: "このグループに送信する権限がありません。" }, { status: 403 });
    }
    const key = "groupmsg:" + groupId;
    const msgs = (await env.DB.get(key, "json")) || [];
    msgs.push({ from: me, text, at: Date.now() });
    const trimmed = msgs.slice(-150);
    await env.DB.put(key, JSON.stringify(trimmed));
    return Response.json({ ok: true, messages: trimmed.slice(-100) });
  }

  const peer = String(body.peer || "").trim();
  if (!peer) {
    return Response.json({ error: "送信先が指定されていません。" }, { status: 400 });
  }
  if (peer !== "admin") {
    const peerUser = await env.DB.get("user:" + peer, "json");
    if (!peerUser || peerUser.status !== "approved") {
      return Response.json({ error: "送信先のIDが見つからないか、まだ許可されていません。" }, { status: 404 });
    }
  }

  const key = dmKey(me, peer);
  const msgs = (await env.DB.get(key, "json")) || [];
  msgs.push({ from: me, text, at: Date.now() });
  const trimmed = msgs.slice(-150);
  await env.DB.put(key, JSON.stringify(trimmed));

  return Response.json({ ok: true, messages: trimmed.slice(-100) });
}
