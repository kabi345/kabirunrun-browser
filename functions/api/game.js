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

function defaultGameState(id) {
  return {
    id,
    spores: 0,
    totalSpores: 0,
    breadIndex: 0,
    upgrades: { spray: 0, closet: 0, bag: 0, lab: 0, planet: 0 },
    characters: [], // [{ uid, charId, obtainedAt }]
    equipped: [],   // [uid1, uid2, uid3]
    prestige: 0,
    updatedAt: Date.now()
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "KVバインディング(DB)が設定されていません。" }, { status: 500 });
  }
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const me = (url.searchParams.get("me") || "").trim();
  const password = (url.searchParams.get("password") || "").trim();

  const auth = await verifyUser(env, me, password);
  if (!auth) {
    return Response.json({ error: "認証に失敗しました。" }, { status: 403 });
  }

  if (action === "state") {
    let state = await env.DB.get("game:" + me, "json");
    if (!state) {
      state = defaultGameState(me);
      await env.DB.put("game:" + me, JSON.stringify(state));
    }

    // Build leaderboard from all game:* keys
    const list = await env.DB.list({ prefix: "game:" });
    const ranking = [];
    for (const k of list.keys) {
      const g = await env.DB.get(k.name, "json");
      if (g && g.id) {
        const leadUid = (g.equipped || [])[0];
        const leadChar = (g.characters || []).find(c => c.uid === leadUid);
        ranking.push({
          id: g.id,
          totalSpores: Number(g.totalSpores || 0),
          breadIndex: Number(g.breadIndex || 0),
          prestige: Number(g.prestige || 0),
          leadCharId: leadChar ? leadChar.charId : null
        });
      }
    }
    ranking.sort((a, b) => b.totalSpores - a.totalSpores);

    // Fetch trades involving `me`
    const tradeList = await env.DB.list({ prefix: "trade:" });
    const incomingTrades = [];
    const outgoingTrades = [];
    for (const tk of tradeList.keys) {
      const tr = await env.DB.get(tk.name, "json");
      if (!tr || tr.status !== "open") continue;
      if (tr.to === me) incomingTrades.push(tr);
      if (tr.from === me) outgoingTrades.push(tr);
    }

    return Response.json({
      ok: true,
      state,
      ranking: ranking.slice(0, 30),
      incomingTrades,
      outgoingTrades
    });
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

  const me = String(body.me || "").trim();
  const password = String(body.password || "").trim();
  const auth = await verifyUser(env, me, password);
  if (!auth) {
    return Response.json({ error: "認証に失敗しました。" }, { status: 403 });
  }

  if (action === "save") {
    const incoming = body.state || {};
    const current = (await env.DB.get("game:" + me, "json")) || defaultGameState(me);

    // Preserve authoritative characters array if any trade happened recently, unless new pulls were added
    const existingMap = new Map((current.characters || []).map(c => [c.uid, c]));
    const clientChars = Array.isArray(incoming.characters) ? incoming.characters : [];
    for (const c of clientChars) {
      if (c && c.uid && c.charId && !existingMap.has(c.uid)) {
        existingMap.set(c.uid, { uid: String(c.uid), charId: String(c.charId), obtainedAt: c.obtainedAt || Date.now() });
      }
    }
    const mergedChars = Array.from(existingMap.values()).slice(0, 200);
    const validUids = new Set(mergedChars.map(c => c.uid));
    const mergedEquipped = (Array.isArray(incoming.equipped) ? incoming.equipped : [])
      .filter(uid => validUids.has(uid))
      .slice(0, 3);

    const updated = {
      id: me,
      spores: Math.max(0, Number(incoming.spores || 0)),
      totalSpores: Math.max(Number(current.totalSpores || 0), Number(incoming.totalSpores || 0)),
      breadIndex: Math.max(0, Number(incoming.breadIndex || 0)),
      upgrades: incoming.upgrades || current.upgrades,
      characters: mergedChars,
      equipped: mergedEquipped,
      prestige: Math.max(0, Number(incoming.prestige || 0)),
      updatedAt: Date.now()
    };
    await env.DB.put("game:" + me, JSON.stringify(updated));
    return Response.json({ ok: true, state: updated });
  }

  if (action === "trade_offer") {
    const peer = String(body.peer || "").trim();
    const myCharUid = String(body.myCharUid || "").trim();
    const wantCharId = String(body.wantCharId || "ANY").trim();

    if (!peer || peer === me) {
      return Response.json({ error: "有効な相手のIDを入力してください。" }, { status: 400 });
    }
    if (peer !== "admin") {
      const peerUser = await env.DB.get("user:" + peer, "json");
      if (!peerUser || peerUser.status !== "approved") {
        return Response.json({ error: "指定された相手IDが見つからないか、まだ許可されていません。" }, { status: 404 });
      }
    }

    const myState = (await env.DB.get("game:" + me, "json")) || defaultGameState(me);
    const offeredChar = (myState.characters || []).find(c => c.uid === myCharUid);
    if (!offeredChar) {
      return Response.json({ error: "指定したキャラクターを所持していません。一度セーブしてから試してください。" }, { status: 400 });
    }

    // Check if this char is already locked in an open trade
    const existingTrades = await env.DB.list({ prefix: "trade:" });
    for (const tk of existingTrades.keys) {
      const tr = await env.DB.get(tk.name, "json");
      if (tr && tr.status === "open" && tr.from === me && tr.fromCharUid === myCharUid) {
        return Response.json({ error: "このキャラクターはすでに別のトレードに出品中です。" }, { status: 400 });
      }
    }

    const tradeId = "tr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const tradeObj = {
      tradeId,
      from: me,
      to: peer,
      fromCharUid: offeredChar.uid,
      fromCharId: offeredChar.charId,
      wantCharId,
      status: "open",
      createdAt: Date.now()
    };
    await env.DB.put("trade:" + tradeId, JSON.stringify(tradeObj));
    return Response.json({ ok: true, trade: tradeObj });
  }

  if (action === "trade_respond") {
    const tradeId = String(body.tradeId || "").trim();
    const accept = Boolean(body.accept);
    const giveCharUid = String(body.giveCharUid || "").trim();

    const tr = await env.DB.get("trade:" + tradeId, "json");
    if (!tr || tr.status !== "open" || tr.to !== me) {
      return Response.json({ error: "有効なトレード申請が見つかりません。" }, { status: 404 });
    }

    if (!accept) {
      tr.status = "rejected";
      await env.DB.put("trade:" + tradeId, JSON.stringify(tr));
      return Response.json({ ok: true, message: "トレードを断りました。" });
    }

    const senderState = await env.DB.get("game:" + tr.from, "json");
    const myState = (await env.DB.get("game:" + me, "json")) || defaultGameState(me);
    if (!senderState) {
      return Response.json({ error: "相手のセーブデータが見つかりません。" }, { status: 404 });
    }

    const senderCharIdx = (senderState.characters || []).findIndex(c => c.uid === tr.fromCharUid);
    if (senderCharIdx === -1) {
      tr.status = "invalid";
      await env.DB.put("trade:" + tradeId, JSON.stringify(tr));
      return Response.json({ error: "相手がそのキャラをすでに手放しているため成立しませんでした。" }, { status: 400 });
    }

    const myCharIdx = (myState.characters || []).findIndex(c => c.uid === giveCharUid);
    if (myCharIdx === -1) {
      return Response.json({ error: "交換に出す自分のキャラクターを選んでください。" }, { status: 400 });
    }
    const myGivenChar = myState.characters[myCharIdx];
    if (tr.wantCharId !== "ANY" && myGivenChar.charId !== tr.wantCharId) {
      return Response.json({ error: "相手が希望しているキャラクターと一致しません。" }, { status: 400 });
    }

    const senderGivenChar = senderState.characters[senderCharIdx];

    // Swap ownership!
    senderState.characters.splice(senderCharIdx, 1, myGivenChar);
    myState.characters.splice(myCharIdx, 1, senderGivenChar);

    // Clean up equipped arrays if swapped char was equipped
    senderState.equipped = (senderState.equipped || []).filter(u => u !== senderGivenChar.uid);
    myState.equipped = (myState.equipped || []).filter(u => u !== myGivenChar.uid);

    tr.status = "completed";
    tr.completedAt = Date.now();

    await env.DB.put("game:" + tr.from, JSON.stringify(senderState));
    await env.DB.put("game:" + me, JSON.stringify(myState));
    await env.DB.put("trade:" + tradeId, JSON.stringify(tr));

    return Response.json({ ok: true, message: "トレードが成立しました！", state: myState });
  }

  if (action === "trade_cancel") {
    const tradeId = String(body.tradeId || "").trim();
    const tr = await env.DB.get("trade:" + tradeId, "json");
    if (!tr || tr.status !== "open" || tr.from !== me) {
      return Response.json({ error: "キャンセルできるトレードが見つかりません。" }, { status: 404 });
    }
    tr.status = "cancelled";
    await env.DB.put("trade:" + tradeId, JSON.stringify(tr));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
