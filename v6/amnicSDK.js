(function () {

  // --------- Stable x_client_id (no external lib) ----------
  const getUniqueKey = () => {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    a[6] = (a[6] & 0x0f) | 0x40; // v4
    a[8] = (a[8] & 0x3f) | 0x80; // variant
    const h = [...a].map(n => n.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };

  let xClientId = localStorage.getItem("x_client_id");
  if (!xClientId) {
    xClientId = getUniqueKey();
    localStorage.setItem("x_client_id", xClientId);
  }
  window.xClientId = xClientId; // optional debug
  console.log("✅ xClientId:", xClientId);

  // ------------------ SETTINGS ------------------
  const cfg = {
    linkedInClientId: "869u3mo71y1bpm",
    redirectUri: "https://gamedev1997.github.io/costSmasherH5/v6",
    scope: "openid profile email",

    // ⚠️ Pick ONE apiBase and keep it consistent (UAT OR PROD)
    apiBase: "https://cost-smashers.uat.amnic.com",
    // apiBase: "https://api.cloudcostsmashers.com",

    xClientIdHeader: "x_client_id",
    xClientIdValue: xClientId,

    storageKey: "auth_token",
    c3: {
      status: "OnLoginStatus",
      success: "OnLoginSuccess",
      error: "OnLoginError",
      player: "OnPlayerInfo",
      gameStart: "OnGameStart",
      gameEnd: "OnGameEnd",
      leaderboard: "OnLeaderboard"
    }
  };

  // ------------------ INTERNAL STATE ------------------
  let token = "";
  let gameId = "";
  let myPlayerId = "";

  // ------------------ HELPERS ------------------
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  const log = (...a) => {
    console.log("[App]", ...a);
    const combined = a.map(d => (typeof d === "object" ? JSON.stringify(d) : String(d))).join(" ");
    if (combined.toLowerCase().includes("leaderboard")) { try { c3_callFunction("LBdataCreate"); } catch {} }
    if (combined.toLowerCase().includes("login success") || combined.toLowerCase().includes("session valid")) {
      try { c3_callFunction("loggedIn"); } catch {}
    }
  };

  const callC3 = (fn, ...args) => { try { globalThis.runtime?.callFunction?.(fn, ...args); } catch {} };

  function authHeaders() {
    if (!token) token = localStorage.getItem(cfg.storageKey) || "";
    const h = { [cfg.xClientIdHeader]: cfg.xClientIdValue || xClientId || "" };
    if (token) h.Authorization = token;
    return h;
  }

  // --------- CORS-friendly HTTP wrapper (frontend-only) ----------
  async function http(url, { method = "GET", headers = {}, body } = {}) {
    const base = {
      "Content-Type": "application/json",
      [cfg.xClientIdHeader]: cfg.xClientIdValue || xClientId || ""
    };
    if (token) base.Authorization = token;

    const res = await fetch(url, {
      method,
      headers: { ...base, ...headers },
      body: body ? JSON.stringify(body) : undefined,
      mode: "cors",
      cache: "no-store",
      redirect: "follow",
      // credentials: "include", // <- ONLY if backend enables credentials CORS
      referrerPolicy: "no-referrer"
    });

    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    log(method, url, res.status, json || text || "");
    return { ok: res.ok, status: res.status, json, text };
  }

  function clearQuery(){ try{ history.replaceState({}, "", location.pathname); }catch{} }

  // --------- Revoked-token helpers ----------
  function resetAuth(reason) {
    try { localStorage.removeItem(cfg.storageKey); } catch {}
    token = "";
    try { sessionStorage.removeItem("li_state"); } catch {}
    console.warn("🔁 resetAuth:", reason || "");
  }
  function isRevokedLinkedIn(res) {
    const t = ((res && (res.text || "")) + " " + JSON.stringify(res?.json || {})).toUpperCase();
    return t.includes("REVOKED_ACCESS_TOKEN") || t.includes('"SERVICEERRORCODE":65601') || t.includes("65601");
  }

  // --------- Single-flight guard (prevent double /v1/login) ----------
  const CODE_LOCK_KEY = "li_code_lock";
  let exchanging = false;
  async function safeExchangeOnce(code) {
    if (exchanging) { log("⏳ exchange skipped (in-flight)"); return false; }
    const locked = sessionStorage.getItem(CODE_LOCK_KEY);
    if (locked && locked === code) { log("🛑 exchange skipped (code already used)"); return false; }
    try { sessionStorage.setItem(CODE_LOCK_KEY, code); } catch {}
    exchanging = true;
    try { return await exchangeCode(code); }
    finally { exchanging = false; /* keep lock to prevent refresh repeat */ }
  }

  // ------------------ MOBILE/FULL-PAGE CALLBACK HANDLER ------------------
  async function handleRedirectIfPresent() {
    const qs = new URLSearchParams(location.search);
    const code = qs.get("code");
    const err  = qs.get("error");
    const back = qs.get("state");

    if (err) { clearQuery(); callC3(cfg.c3.error, err); return; }
    if (!code) return;

    const saved = sessionStorage.getItem("li_state");
    if (saved && back !== saved) { clearQuery(); callC3(cfg.c3.error, "state_mismatch"); return; }

    const ok = await safeExchangeOnce(code);
    clearQuery();
    if (ok) { callC3(cfg.c3.success); callC3(cfg.c3.status, "logged_in"); }
    else    { callC3(cfg.c3.error, "login_failed"); }
  }

  // ------------------ 1) LOGIN ------------------
  window.loginWithLinkedIn = function (force) {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("li_state", state);

    let url = "https://www.linkedin.com/oauth/v2/authorization"
      + "?response_type=code"
      + "&client_id=" + encodeURIComponent(cfg.linkedInClientId)
      + "&redirect_uri=" + encodeURIComponent(cfg.redirectUri)
      + "&scope=" + encodeURIComponent(cfg.scope)
      + "&state=" + encodeURIComponent(state);

    if (force) url += "&prompt=login";

    if (isMobile) {
      window.location.assign(url);
      return;
    }

    const w = 600, h = 700, left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    const pop = window.open(url, "linkedin_popup",
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!pop) { callC3(cfg.c3.error, "popup_blocked"); return; }

    const timer = setInterval(async () => {
      try {
        if (!pop || pop.closed) { clearInterval(timer); return; }
        const href = pop.location.href; // throws until same-origin
        if (href.startsWith(cfg.redirectUri) && href.includes("?code=")) {
          clearInterval(timer);
          const sp = new URL(href).searchParams;
          const code = sp.get("code");
          const backState = sp.get("state");
          const saved = sessionStorage.getItem("li_state");
          if (saved && backState !== saved) { pop.close(); callC3(cfg.c3.error, "state_mismatch"); return; }
          try { pop.document.body.innerHTML = "<p style='font:14px sans-serif;padding:16px'>Logging you in…</p>"; } catch {}
          const ok = await safeExchangeOnce(code);
          pop.close();
          if (ok) { log("✅ Login success"); callC3(cfg.c3.success); callC3(cfg.c3.status, "logged_in"); }
          else    { log("❌ Login failed");  callC3(cfg.c3.error, "login_failed"); }
        }
      } catch {}
    }, 400);
  };

  // ------------------ 2) EXCHANGE CODE → TOKEN ------------------
  async function exchangeCode(code) {
    const r = await http(`${cfg.apiBase}/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [cfg.xClientIdHeader]: cfg.xClientIdValue },
      body: { authorization_code: code, redirect_uri: cfg.redirectUri }
    });

    if (!r.ok) {
      if (isRevokedLinkedIn(r)) {
        resetAuth("revoked_token");
        setTimeout(() => window.loginWithLinkedIn(true), 100);
      }
      return false;
    }

    token = r.json?.auth_key || r.json?.access_token || r.json?.token || "";
    if (!token) return false;
    try { localStorage.setItem(cfg.storageKey, token); } catch {}
    log("🔐 token saved");
    myPlayerId = r.json.player_id;
    try { c3_callFunction("setPlayerId", [myPlayerId]); } catch {}
    return true;
  }

  // ------------------ 3) SESSION CHECK ------------------
  async function checkLogin() {
    token = localStorage.getItem(cfg.storageKey) || "";
    if (!token) { callC3(cfg.c3.status, "logged_out"); return false; }
    const r = await http(`${cfg.apiBase}/v1/player`, { headers: authHeaders() });
    if (r.ok) {
      log("👤 session valid"); callC3(cfg.c3.status, "logged_in");
      myPlayerId = r.json.player_id;
      try { c3_callFunction("setPlayerId", [myPlayerId]); } catch {}
      return true;
    }
    try { localStorage.removeItem(cfg.storageKey); } catch {}
    token = "";
    log("🔓 session invalid → logged_out");
    callC3(cfg.c3.status, "logged_out");
    return false;
  }
  window.checkLogin = checkLogin;

  // ------------------ 4) API HELPERS ------------------
  window.getPlayerInfo = async function () {
    const r = await http(`${cfg.apiBase}/v1/player`, { headers: authHeaders() });
    if (!r.ok) { callC3(cfg.c3.error, "player_failed", r.text || ""); return; }
    console.log("✅ player", r.json);
    callC3(cfg.c3.player, JSON.stringify(r.json || {}));
  };

  window.startGame = async function () {
    const r = await http(`${cfg.apiBase}/v1/game/start`, { method: "POST", headers: authHeaders() });
    if (!r.ok) { callC3(cfg.c3.error, "start_failed", r.text || ""); return; }
    gameId = r.json?.game_id || r.json?.id || "";
    log("✅ game started", gameId);
    callC3(cfg.c3.gameStart, gameId);
  };

  window.endGame = async function (score, status = "FINISHED") {
    if (!gameId) { callC3(cfg.c3.error, "missing_game_id"); return; }
    const s = Number(score);
    if (!Number.isFinite(s)) { callC3(cfg.c3.error, "invalid_score"); return; }

    const r = await http(`${cfg.apiBase}/v1/game/end`, {
      method: "POST",
      headers: authHeaders(),
      body: { game_id: gameId, score: s, status: String(status || "FINISHED") }
    });
    if (!r.ok) { callC3(cfg.c3.error, "end_failed", r.text || ""); return; }
    log("✅ game ended", r.json);
    callC3(cfg.c3.gameEnd, JSON.stringify(r.json || {}));
  };

  window.getLeaderboard = async function (period = "daily") {
    try {
      const url = `${cfg.apiBase}/v1/leaderboard?period=${encodeURIComponent(period)}`;
      const res = await http(url, { headers: authHeaders() });

      if (!res?.ok) { callC3(cfg.c3.error, "leaderboard_failed", res?.text || ""); return; }

      const data =
        Array.isArray(res?.json) ? res.json :
        Array.isArray(res?.json?.data) ? res.json.data :
        Array.isArray(res?.json?.items) ? res.json.items :
        [];

      console.log(`✅ leaderboard[${period}]`, data);

      for (const p of data) {
        const { player_id, display_name, avatar, score, rank } = p;
        try { c3_callFunction("LBData",[display_name,player_id,avatar,rank,score]); } catch {}
      }
      callC3(cfg.c3.leaderboard, JSON.stringify(data));
    } catch (err) {
      console.error("❌ leaderboard error:", err);
      callC3(cfg.c3.error, "leaderboard_failed", String(err));
    }
  };

  // ------------------ 5) AUTO: handle redirect (iOS/Android) ------------------
  (async function init() {
    await handleRedirectIfPresent(); // no-op on normal loads
    // optionally also: await checkLogin();
  })();

})();
// --------- END OF amnicSDK.js ----------