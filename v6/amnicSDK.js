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
    // Keep exact path as registered in LinkedIn (match LinkedIn app settings)
    redirectUri: "https://gamedev1997.github.io/costSmasherH5/v6/",
    scope: "openid profile email",

    apiBase: "https://cost-smashers.uat.amnic.com",
    xClientIdHeader: "x_client_id",
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
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  const log = (...a) => {
    console.log("[App]", ...a);

    const combined = a.map(data => (typeof data === "object" ? JSON.stringify(data) : String(data))).join(" ");

    console.log("combine..", combined);
    try {
      if (combined.toLowerCase().includes("leaderboard")) {
        c3_callFunction("LBdataCreate");
      }
      if (combined.toLowerCase().includes("login success") || combined.toLowerCase().includes("session valid")) {
        c3_callFunction("loggedIn");
      }
    } catch {}
  };

  const callC3 = (fn, ...args) => { try { globalThis.runtime?.callFunction?.(fn, ...args); } catch {} };

  function authHeaders() {
    if (!token) token = localStorage.getItem(cfg.storageKey) || "";
    const h = { [cfg.xClientIdHeader]: cfg.xClientIdValue || xClientId || "" };
    if (token) h.Authorization = token;
    return h;
  }

  // --------- CORS-friendly HTTP wrapper ----------
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
      referrerPolicy: "no-referrer"
      // credentials: "include" // only if backend supports credentials
    });

    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    log(method, url, res.status, json || text || "");
    return { ok: res.ok, status: res.status, json, text };
  }

  function clearQuery(){ try{ history.replaceState({}, "", location.pathname); }catch{} }

  // ---------- helpers to handle revoked-token flow ----------
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

  // ---------- PKCE helpers ----------
  async function sha256(buffer) {
    return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(buffer));
  }
  function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = "";
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function genCodeVerifier() {
    // 64 bytes -> base64url ~86 chars; we will use whole string
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr).slice(0,128);
  }
  async function genCodeChallenge(verifier) {
    const hashed = await sha256(verifier);
    return base64UrlEncode(hashed);
  }

  // ---------- SINGLE-FLIGHT GUARDS TO PREVENT DOUBLE EXCHANGE ----------
  const CODE_LOCK_KEY = "li_code_lock";
  let exchanging = false;

  async function safeExchangeOnce(code) {
    if (exchanging) {
      log("⏳ exchange skipped (in-flight)");
      return false;
    }
    const locked = sessionStorage.getItem(CODE_LOCK_KEY);
    if (locked && locked === code) {
      log("🛑 exchange skipped (code already used in this session)");
      return false;
    }

    try { sessionStorage.setItem(CODE_LOCK_KEY, code); } catch {}
    exchanging = true;
    try {
      const ok = await exchangeCode(code);
      return ok;
    } finally {
      exchanging = false;
    }
  }

  // ---------- message listener: accept code FROM popup ----------
  window.addEventListener("message", async (ev) => {
    try {
      // accept only messages from same origin (change if needed)
      if (!ev.origin || ev.origin !== location.origin) return;
      const data = ev.data || {};
      if (data && data.type === "linkedin_oauth" && data.code) {
        log("📩 Received oauth code from popup via postMessage");
        await safeExchangeOnce(String(data.code));
      }
    } catch (e) {
      console.warn("message listener error", e);
    }
  });

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

    // If running inside a popup opened by the main window, DO NOT exchange here.
    // Post the code to the opener and close the popup.
    try {
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: "linkedin_oauth", code: code, state: back || null }, location.origin);
        } catch (e) {
          try { window.opener.postMessage({ type: "linkedin_oauth", code: code, state: back || null }, "*"); } catch {}
        }
        try { clearQuery(); } catch {}
        try { window.close(); } catch {}
        return;
      }
    } catch (ex) {
      console.warn("handleRedirectIfPresent popup-opener check failed", ex);
    }

    // Normal flow (not popup / mobile redirect): exchange once here
    const ok = await safeExchangeOnce(code);

    // Attempt to restore mobile return state if present
    let mobileReturn = null;
    try {
      const raw = sessionStorage.getItem("li_mobile_return");
      if (raw) mobileReturn = JSON.parse(raw);
    } catch (e) { mobileReturn = null; }

    if (ok) {
      callC3(cfg.c3.success);
      callC3(cfg.c3.status, "logged_in");
      try { c3_callFunction("loggedIn"); } catch {}

      // If we have a saved mobile return point, restore it without reloading
      if (mobileReturn && sessionStorage.getItem("li_mobile_inflight") === "1") {
        try {
          const targetPath = (mobileReturn.pathname || "/") + (mobileReturn.hash || "");
          history.replaceState({}, "", targetPath);
          if (typeof mobileReturn.scrollY === "number") {
            try { window.scrollTo(0, mobileReturn.scrollY); } catch {}
          }
        } catch (e) {
          console.warn("restore mobile return failed", e);
        } finally {
          try { sessionStorage.removeItem("li_mobile_return"); } catch {}
          try { sessionStorage.removeItem("li_mobile_inflight"); } catch {}
        }
      } else {
        try { clearQuery(); } catch {}
      }
      return;
    } else {
      callC3(cfg.c3.error, "login_failed");
      try { sessionStorage.removeItem("li_mobile_inflight"); } catch {}
      try { clearQuery(); } catch {}
      return;
    }
  }

  // ------------------ 1) LOGIN (POPUP on desktop, REDIRECT on mobile) ------------------
  window.loginWithLinkedIn = async function (force) {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("li_state", state);

    // PKCE: generate verifier & challenge, store verifier to sessionStorage
    const code_verifier = genCodeVerifier();
    sessionStorage.setItem("li_code_verifier", code_verifier);
    const code_challenge = await genCodeChallenge(code_verifier);

    let url = "https://www.linkedin.com/oauth/v2/authorization"
      + "?response_type=code"
      + "&client_id=" + encodeURIComponent(cfg.linkedInClientId)
      + "&redirect_uri=" + encodeURIComponent(cfg.redirectUri)
      + "&scope=" + encodeURIComponent(cfg.scope)
      + "&state=" + encodeURIComponent(state)
      + "&code_challenge=" + encodeURIComponent(code_challenge)
      + "&code_challenge_method=S256";

    if (force) url += "&prompt=login";

    if (isMobile) {
      // iOS/Android: full-page redirect
      // Save a "return point" so after LinkedIn redirects back we can restore state without reloading
      try {
        const returnInfo = {
          href: location.href,
          pathname: location.pathname,
          hash: location.hash || "",
          scrollY: window.scrollY || 0,
          timestamp: Date.now()
        };
        sessionStorage.setItem("li_mobile_return", JSON.stringify(returnInfo));
        sessionStorage.setItem("li_mobile_inflight", "1");
      } catch (e) { console.warn("could not save return info", e); }

      window.location.assign(url);
      return;
    }

    // Desktop: popup
    const w = 600, h = 700, left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    const pop = window.open(url, "linkedin_popup",
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!pop) { callC3(cfg.c3.error, "popup_blocked"); return; }

    // Poll popup until redirectUri reached (we won't exchange in popup; popup will postMessage)
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

          try { pop.document.body.innerHTML = "<p style='font:14px sans-serif;padding:16px'>Processing…</p>"; } catch {}
          // Instead of exchange here, rely on popup to postMessage; but if postMessage fails,
          // we still attempt safeExchangeOnce(code) as a fallback (safeExchangeOnce prevents double-exchange).
          try {
            // give popup a short moment to postMessage
            await new Promise(res => setTimeout(res, 150));
            // Fallback attempt (safe)
            const ok = await safeExchangeOnce(code);
            pop.close();
            if (ok) {
              log("✅ Login success");
              callC3(cfg.c3.success);
              callC3(cfg.c3.status, "logged_in");
              try { c3_callFunction("loggedIn"); } catch {}
            }
            else {
              log("❌ Login failed");
              callC3(cfg.c3.error, "login_failed");
            }
          } catch (e) {
            try { pop.close(); } catch {}
            log("❌ Login failed (popup flow)", e);
            callC3(cfg.c3.error, "login_failed");
          }
        }
      } catch { /* ignore cross-origin until redirectUri reached */ }
    }, 400);
  };

  // ------------------ 2) EXCHANGE CODE → TOKEN ------------------
  async function exchangeCode(code) {
    // include code_verifier (PKCE) if available
    const verifier = sessionStorage.getItem("li_code_verifier") || null;

    const r = await http(`${cfg.apiBase}/v1/login`, {
      method: "POST",
      headers: { [cfg.xClientIdHeader]: cfg.xClientIdValue, "Content-Type": "application/json" },
      body: { authorization_code: code, redirect_uri: cfg.redirectUri, code_verifier: verifier }
    });

    if (!r.ok) {
      // revoked token handling
      if (isRevokedLinkedIn(r)) {
        console.warn("♻️ LinkedIn grant revoked → clearing and forcing fresh OAuth");
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
    console.log("PlayerInfo..", myPlayerId);
    try { c3_callFunction("setPlayerId",[myPlayerId]); } catch {}

    // <<< notify Construct 3 that user is logged in
    try { c3_callFunction("loggedIn"); } catch {}

    // cleanup PKCE verifier after successful exchange
    try { sessionStorage.removeItem("li_code_verifier"); } catch {}

    return true;
  }

  // ------------------ 3) SESSION CHECK (call on refresh) ------------------
  async function checkLogin() {
    token = localStorage.getItem(cfg.storageKey) || "";
    if (!token) { callC3(cfg.c3.status, "logged_out"); return false; }
    const r = await http(`${cfg.apiBase}/v1/player`, { headers: authHeaders() });
    if (r.ok) {
      log("👤 session valid");
      callC3(cfg.c3.status, "logged_in");
      console.log("token...", cfg.storageKey);
      myPlayerId = r.json.player_id;
      console.log("PlayerInfo..", myPlayerId);
      try { c3_callFunction("setPlayerId",[myPlayerId]); } catch {}

      // <<< notify Construct 3 that user is logged in (session validated)
      try { c3_callFunction("loggedIn"); } catch {}

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

      for (const player of data) {
        const { player_id, display_name, avatar, score, rank } = player;
        console.log(`👤 ${display_name} | Score: ${score} | Rank: ${rank} | ID: ${player_id} | Avatar: ${avatar}`);
        try { c3_callFunction("LBData",[display_name,player_id,avatar,rank,score]); } catch {}
      }

      callC3(cfg.c3.leaderboard, JSON.stringify(data));
    } catch (err) {
      console.error("❌ leaderboard error:", err);
      callC3(cfg.c3.error, "leaderboard_failed", String(err));
    }
  };

  // ------------------ 5) AUTO: handle mobile/full-page redirect (iOS/Android) ------------------
  (async function init() {
    await handleRedirectIfPresent(); // will no-op on desktop normal loads
    // optionally also: await checkLogin();
  })();

})();


// new Code for popup window v3