(function () {
  'use strict';

  // -----------------------------
  // Small helpers
  // -----------------------------
  function isString(v) { return typeof v === 'string'; }
  function defined(v) { return typeof v !== 'undefined'; }

  function safeLog() {
    try { console.log.apply(console, arguments); } catch (e) {}
  }
  function safeWarn() {
    try { console.warn.apply(console, arguments); } catch (e) {}
  }
  function safeError() {
    try { console.error.apply(console, arguments); } catch (e) {}
  }

  function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : (url + '/');
  }
  // Always show parse/runtime errors, even if emulator.js breaks badly
  window.addEventListener('error', function (ev) {
    try {
      safeError('window.error:', ev && (ev.message || ev.type), ev && ev.filename, ev && ev.lineno, ev && ev.colno, ev && ev.error);
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      safeError('unhandledrejection:', ev && ev.reason);
    } catch (e) {}
  });

  // Normalize a base path to an absolute URL.
  // Accepts:
  // - absolute: https://..., http://...
  // - protocol-relative: //host/path
  // - root-relative: /path
  // - relative: ./path, ../path, themes/... etc
  function normalizeBasePath(input) {
    var raw = isString(input) && input.length ? input : './';

    // If it's already absolute (http/https)
    if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0) {
      return ensureTrailingSlash(raw);
    }

    // If it's protocol-relative
    if (raw.indexOf('//') === 0) {
      return ensureTrailingSlash(window.location.protocol + raw);
    }

    // If it's root-relative
    if (raw.indexOf('/') === 0) {
      return ensureTrailingSlash(window.location.protocol + '//' + window.location.host + raw);
    }

    // Otherwise treat as relative to current document URL
    try {
      var abs = new URL(raw, window.location.href).href;
      return ensureTrailingSlash(abs);
    } catch (e) {
      // Worst case fallback
      var fallback = window.location.protocol + '//' + window.location.host + '/';
      return fallback;
    }
  }



    // Your repo version.json
    var url = 'https://cdn.jsdelivr.net/gh/StaticQuasar931/Croc--Legend-of-the-Gobbos@main/version.json';

    try {
      fetch(url).then(function (res) {
        if (!res || !res.ok) return;
        return res.text();
      }).then(function (body) {
        if (!body) return;
        var data;
        try { data = JSON.parse(body); } catch (e) { return; }
        if (!data || !data.current_version) return;
        if (usingVersion !== data.current_version) {
          safeLog('Using emulatorjs version ' + usingVersion + ' but the newest version is ' + data.current_version);
        }
      }).catch(function () {});
    } catch (e) {}
  }


// Keep your blob head-info behavior but make it safe and simple.
// normalFunc is expected to be a function(url, options) that returns a promise or value.
window.getHeadGameInfo = function (normalFunc, url) {
  if (typeof url !== "string" || url.indexOf("blob:") !== 0) {
    return normalFunc(url, {});
  }

  return (async function () {
    var r = await fetch(url);
    var b = await r.blob();
    return {
      headers: {
        "content-length": String(b.size),
        "content-type": b.type || "application/octet-stream"
      }
    };
  })();
};
  // ----------------------------
  // Validate required globals
  // ----------------------------
  function assertRequiredGlobals() {
    var missing = [];

    if (!defined(window.EJS_player)) missing.push('EJS_player');
    if (!defined(window.EJS_core)) missing.push('EJS_core');
    if (!defined(window.EJS_gameUrl)) missing.push('EJS_gameUrl');

    if (missing.length) {
      safeError('loader.js missing required globals:', missing.join(', '));
      throw new Error('Missing required globals: ' + missing.join(', '));
    }
  }

  // Build the config object from EJS_* globals
  function buildCfg() {
    var cfg = {};

    // Required
    cfg.gameUrl = window.EJS_gameUrl;
    cfg.system = window.EJS_core;

    // Optional
    if (defined(window.EJS_biosUrl)) cfg.biosUrl = window.EJS_biosUrl;
    if (defined(window.EJS_gameID)) cfg.gameId = window.EJS_gameID;
    if (defined(window.EJS_gameParentUrl)) cfg.gameParentUrl = window.EJS_gameParentUrl;
    if (defined(window.EJS_gamePatchUrl)) cfg.gamePatchUrl = window.EJS_gamePatchUrl;

    // Save states
    cfg.onsavestate = null;
    cfg.onloadstate = null;
    if (defined(window.EJS_onSaveState)) cfg.onsavestate = window.EJS_onSaveState;
    if (defined(window.EJS_onLoadState)) cfg.onloadstate = window.EJS_onLoadState;

    // Input options
    if (defined(window.EJS_lightgun)) cfg.lightgun = window.EJS_lightgun;
    if (defined(window.EJS_mouse)) cfg.mouse = window.EJS_mouse;
    if (defined(window.EJS_multitap)) cfg.multitap = window.EJS_multitap;

    // User options
    if (defined(window.EJS_playerName)) cfg.playerName = window.EJS_playerName;
    if (defined(window.EJS_cheats)) cfg.cheats = window.EJS_cheats;
    if (defined(window.EJS_color)) cfg.color = window.EJS_color;

    return cfg;
  }

  // Try to find the constructor after emulator.js loads.
  // This is the core fix for "EJS is missing after emulator.js load".
  function pickCtor() {
    var ctor = null;

    // Most likely
    ctor = window.EJS;
    if (ctor && typeof ctor === 'object' && typeof ctor.default === 'function') ctor = ctor.default;
    if (typeof ctor === 'function') return ctor;

    // Common alternates
    var alt = window.EmulatorJS || window.Emulator || window.EJS_Emulator;
    if (alt && typeof alt === 'object' && typeof alt.default === 'function') alt = alt.default;
    if (typeof alt === 'function') return alt;

    // Nothing found
    return null;
  }

function loadScript(src, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.async = false;
    s.defer = false;
    s.src = src;
    s.crossOrigin = 'anonymous';

    var done = false;
    var t = setTimeout(function () {
      if (done) return;
      done = true;
      try { s.remove(); } catch (e) {}
      reject(new Error('Timed out loading script: ' + src));
    }, timeoutMs);

    s.onload = function () {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve();
    };
    s.onerror = function (e) {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e || new Error('Failed to load script: ' + src));
    };

    var first = document.getElementsByTagName('script')[0];
    if (first && first.parentNode) first.parentNode.insertBefore(s, first);
    else document.head.appendChild(s);
  });
}

  async function start() {
    checkNewestVersion();

    // EJS_pathtodata default
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = './';
    }

    // Normalize to an absolute base path
    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);
    safeLog('Path to data is set to ' + window.EJS_pathtodata);

    // Required globals must exist before we construct
    assertRequiredGlobals();

    // Compose emulator.js URL
    // If you want cache busting, keep a stable version string here.
    var emuUrl = window.EJS_pathtodata + 'emulator.js?v=0.4.23';

    // Load emulator.js
    try {
      await loadScript(emuUrl);
    } catch (e) {
      safeError('Failed to load emulator.js:', emuUrl, e);
      throw new Error('emulator.js failed to load: ' + emuUrl);
    }

    // Give emulator.js a moment to attach globals (some builds do it after a tick)
    var ctor = null;
    for (var i = 0; i < 50; i++) {
      ctor = pickCtor();
      if (typeof ctor === 'function') break;
      await new Promise(function (r) { setTimeout(r, 20); });
    }

    if (typeof ctor !== 'function') {
      safeError('EJS constructor missing after emulator.js load. URL:', emuUrl);
      safeError('typeof window.EJS:', typeof window.EJS);
      safeError('typeof window.EmulatorJS:', typeof window.EmulatorJS);
      safeError('typeof window.Emulator:', typeof window.Emulator);
      throw new TypeError('EJS is not a constructor (missing)');
    }

    // Build cfg and construct
    var cfg = buildCfg();
    var inst = new ctor(window.EJS_player, cfg);

    // Expose instance in the most compatible way
    window.EJS_emulator = inst;

    // Some themes expect the instance elsewhere too, keep both
    // (If you do not want duplicates, delete the next line.)

    // Hook start-game if present
    if (defined(window.EJS_onGameStart) && inst && typeof inst.on === 'function') {
      inst.on('start-game', window.EJS_onGameStart);
    }
  }

  // Run
  start().catch(function (e) {
    safeError('loader.js fatal error:', e);
  });
})();