// Login Via Linkedin



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


  // ------------------ SETTINGS (edit if needed) ------------------
  const cfg = {
    linkedInClientId: "869u3mo71y1bpm",
    redirectUri: "https://gamedev1997.github.io/costSmasherH5/v6/",
    scope: "openid profile email",

    apiBase: "https://cost-smashers.uat.amnic.com",
    xClientIdHeader: "x_client_id",
    // ⚠️ yahan LinkedIn client id mat bhejna. Backend ka x_client_id value use karo:
    xClientIdValue: xClientId,

    storageKey: "auth_token", // where we store the API auth key
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

  // ------------------ SMALL HELPERS ------------------
  // const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const isMobile = false;


  const log = (...a) => {
    console.log("[App]", ...a);

    const combined = a.map(data => (typeof data === "object" ? JSON.stringify(data) : String(data))).join(" ");

    console.log("combine..",combined)
  if (combined.toLowerCase().includes("leaderboard")) {

  c3_callFunction("LBdataCreate")
    
  } 

  if (
  combined.toLowerCase().includes("login success") ||
  combined.toLowerCase().includes("session valid")
) {
  console.log("combine..Login...", myPlayerId);
  
  c3_callFunction("loggedIn");
}


    
        

    // guard so it won't crash if not defined
    try { if (typeof c3_callFunction === "function") {} } catch {}
  };

  const callC3 = (fn, ...args) => { try { globalThis.runtime?.callFunction?.(fn, ...args); } catch {} };

  function authHeaders() {
    if (!token) token = localStorage.getItem(cfg.storageKey) || "";
    const h = { [cfg.xClientIdHeader]: cfg.xClientIdValue };
    if (token) h.Authorization = token;
    return h;
  }

  async function http(url, { method = "GET", headers = {}, body } = {}) {
    const all = { ...headers };
    if (body && !all["Content-Type"]) all["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers: all, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    log(method, url, res.status, json || text || "");
    return { ok: res.ok, status: res.status, json, text };
  }

  function clearQuery(){ try{ history.replaceState({}, "", location.pathname); }catch{} }

  // ------------------ MOBILE/FULL-PAGE CALLBACK HANDLER (auto) ------------------
  async function handleRedirectIfPresent() {
    const qs = new URLSearchParams(location.search);
    const code = qs.get("code");
    const err  = qs.get("error");
    const back = qs.get("state");

    if (err) { clearQuery(); callC3(cfg.c3.error, err); return; }
    if (!code) return;

    const saved = sessionStorage.getItem("li_state");
    if (saved && back !== saved) { clearQuery(); callC3(cfg.c3.error, "state_mismatch"); return; }

    const ok = await exchangeCode(code);
    clearQuery();
    if (ok) { callC3(cfg.c3.success); callC3(cfg.c3.status, "logged_in"); }
    else    { callC3(cfg.c3.error, "login_failed"); }
  }

  // ------------------ 1) LOGIN (POPUP on desktop, REDIRECT on mobile) ------------------
  window.loginWithLinkedIn = function () {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("li_state", state);

    const url = "https://www.linkedin.com/oauth/v2/authorization"
      + "?response_type=code"
      + "&client_id=" + encodeURIComponent(cfg.linkedInClientId)
      + "&redirect_uri=" + encodeURIComponent(cfg.redirectUri)
      + "&scope=" + encodeURIComponent(cfg.scope)
      + "&state=" + encodeURIComponent(state);

    if (isMobile) {
      // ✅ iOS/Android: full-page redirect (reliable)
      window.location.assign(url);
      return;
    }

    // 🖥️ Desktop: popup
    const w = 600, h = 700, left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    const pop = window.open(url, "linkedin_popup",
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!pop) { callC3(cfg.c3.error, "popup_blocked"); return; }

    const timer = setInterval(async () => {
      try {
        if (!pop || pop.closed) { clearInterval(timer); return; }
        const href = pop.location.href; // throws until redirectUri reached
        if (href.startsWith(cfg.redirectUri) && href.includes("?code=")) {
          clearInterval(timer);
          const sp = new URL(href).searchParams;
          const code = sp.get("code");
          const backState = sp.get("state");
          const saved = sessionStorage.getItem("li_state");
          if (saved && backState !== saved) { pop.close(); callC3(cfg.c3.error, "state_mismatch"); return; }

          try { pop.document.body.innerHTML = "<p style='font:14px sans-serif;padding:16px'>Logging you in…</p>"; } catch {}
          const ok = await exchangeCode(code);
          pop.close();
          if (ok) { log("✅ Login success"); callC3(cfg.c3.success); callC3(cfg.c3.status, "logged_in"); }
          else    { log("❌ Login failed");  callC3(cfg.c3.error, "login_failed"); }
        }
      } catch { /* ignore until same-origin */ }
    }, 400);
  };

  // ------------------ 2) EXCHANGE CODE → TOKEN ------------------
  async function exchangeCode(code) {
    const r = await http(`${cfg.apiBase}/v1/login`, {
      method: "POST",
      headers: { [cfg.xClientIdHeader]: cfg.xClientIdValue, "Content-Type": "application/json" },
      body: { authorization_code: code, redirect_uri: cfg.redirectUri }
    });
    if (!r.ok) return false;
    token = r.json?.auth_key || r.json?.access_token || r.json?.token || "";
    if (!token) return false;
    try { localStorage.setItem(cfg.storageKey, token); } catch {}
    log("🔐 token saved");
    myPlayerId = r.json.player_id;
    console.log("PlayerInfo..",myPlayerId);
      c3_callFunction("setPlayerId",[myPlayerId]);

    return true;
  }

  // ------------------ 3) SESSION CHECK (call on refresh) ------------------
  async function checkLogin() {
    token = localStorage.getItem(cfg.storageKey) || "";
    if (!token) { callC3(cfg.c3.status, "logged_out"); return false; }
    const r = await http(`${cfg.apiBase}/v1/player`, { headers: authHeaders() });
    if (r.ok) { log("👤 session valid"); callC3(cfg.c3.status, "logged_in");
    console.log("token...",cfg.storageKey);
    myPlayerId = r.json.player_id;
        console.log("PlayerInfo..",myPlayerId);
              c3_callFunction("setPlayerId",[myPlayerId]);


     return true; 
    
    }
    // token invalid → clear
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

    console.log("↩️ raw response:", res);

    if (!res?.ok) {
      callC3(cfg.c3.error, "leaderboard_failed", res?.text || "");
      return;
    }

    // Normalize payload: expect an array in res.json
    const data =
      Array.isArray(res?.json) ? res.json :
      Array.isArray(res?.json?.data) ? res.json.data :
      Array.isArray(res?.json?.items) ? res.json.items :
      [];

    console.log(`✅ leaderboard[${period}]`, data);



    // Loop through each player separately
    for (const player of data) {
      const { player_id, display_name, avatar, score, rank } = player;
      console.log(`👤 ${display_name} | Score: ${score} | Rank: ${rank} | ID: ${player_id} | Avatar: ${avatar}`);

      c3_callFunction("LBData",[display_name,player_id,avatar,rank,score])
      

      // If you want to send each row separately to C3, uncomment this:
      // callC3(cfg.c3.leaderboard_item, JSON.stringify(player));
    }

    // Send the full list to C3
    callC3(cfg.c3.leaderboard, JSON.stringify(data));
  } catch (err) {
    console.error("❌ leaderboard error:", err);
    callC3(cfg.c3.error, "leaderboard_failed", String(err));
  }
};


  // ------------------ 5) AUTO: handle mobile/full-page redirect (iOS/Android) ------------------
  (async function init() {
    await handleRedirectIfPresent(); // will no-op on desktop normal loads
    // optional: also check existing session on load
    // await checkLogin();
  })();
})();
