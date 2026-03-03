(function () {
  'use strict';

  // -------------------------------------------------
  // DIAGNOSTIC MODE
  // -------------------------------------------------
  // Leave this ON until we see the logs.
  // After it is fixed, you can set it to false.
  var DIAG = true;

  // -----------------------------
  // Small helpers
  // -----------------------------
  function isString(v) { return typeof v === 'string'; }
  function defined(v) { return typeof v !== 'undefined'; }

  function safeLog() { try { console.log.apply(console, arguments); } catch (e) {} }
  function safeWarn() { try { console.warn.apply(console, arguments); } catch (e) {} }
  function safeError() { try { console.error.apply(console, arguments); } catch (e) {} }

  function dlog() {
    if (!DIAG) return;
    try { console.log.apply(console, ['[EJS-DIAG]'].concat([].slice.call(arguments))); } catch (e) {}
  }
  function dwarn() {
    if (!DIAG) return;
    try { console.warn.apply(console, ['[EJS-DIAG]'].concat([].slice.call(arguments))); } catch (e) {}
  }
  function derror() {
    if (!DIAG) return;
    try { console.error.apply(console, ['[EJS-DIAG]'].concat([].slice.call(arguments))); } catch (e) {}
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
  function normalizeBasePath(input) {
    var raw = isString(input) && input.length ? input : './';

    if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0) {
      return ensureTrailingSlash(raw);
    }
    if (raw.indexOf('//') === 0) {
      return ensureTrailingSlash(window.location.protocol + raw);
    }
    if (raw.indexOf('/') === 0) {
      return ensureTrailingSlash(window.location.protocol + '//' + window.location.host + raw);
    }

    try {
      var abs = new URL(raw, window.location.href).href;
      return ensureTrailingSlash(abs);
    } catch (e) {
      return window.location.protocol + '//' + window.location.host + '/';
    }
  }

  // -------------------------------------------------
  // DIAGNOSTIC HOOKS: Worker + locateFile visibility
  // -------------------------------------------------
  // The "Attempting to create a Worker from an empty source" is the smoking gun.
  // This patch logs EXACTLY what Worker arg is used, and stops the app with a clear error
  // if it tries to do new Worker("") or new Worker(undefined).
  var RealWorker = window.Worker;
  if (RealWorker && !RealWorker.__ejs_diag_wrapped) {
    function WrappedWorker(url, opts) {
      try {
        var u = url;
        var t = (typeof u);
        var shown = '';
        try { shown = String(u); } catch (e) { shown = '[unstringable]'; }

        dlog('Worker() called with:', { type: t, url: shown });

        // Catch "empty source" immediately so we know what called it.
        if (!u || (isString(u) && u.trim() === '')) {
          derror('EMPTY Worker source detected. This is why it hangs on Loading.');
          // Print a small stack so we can identify where it comes from
          try { throw new Error('EJS empty Worker source stack'); } catch (err) { derror(err && err.stack ? err.stack : err); }
          throw new Error('Blocked empty Worker() source. See [EJS-DIAG] logs above.');
        }
      } catch (e) {
        // If our logging throws, do not hide the original problem
        derror('Worker diag wrapper error:', e);
      }
      return new RealWorker(url, opts);
    }
    WrappedWorker.__ejs_diag_wrapped = true;
    window.Worker = WrappedWorker;
    dlog('Installed Worker() diagnostic wrapper');
  } else {
    dlog('Worker() not available or already wrapped');
  }

  // -------------------------------------------------
  // Blob head-info behavior for EJS_gameUrl=blob:
  // -------------------------------------------------
  // normalFunc is expected to be a function(url, options) that returns a promise or value.
  window.getHeadGameInfo = function (normalFunc, url) {
    try {
      if (typeof url !== "string" || url.indexOf("blob:") !== 0) {
        return normalFunc(url, {});
      }
    } catch (e) {
      return normalFunc(url, {});
    }

    return (async function () {
      try {
        var r = await fetch(url);
        var b = await r.blob();
        return {
          headers: {
            "content-length": String((b && b.size) || 0),
            "content-type": (b && b.type) || "application/octet-stream"
          }
        };
      } catch (e) {
        return {
          headers: {
            "content-length": "0",
            "content-type": "application/octet-stream"
          }
        };
      }
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

    cfg.gameUrl = window.EJS_gameUrl;
    cfg.system = window.EJS_core;

    // Pass data path aliases
    cfg.pathtodata = window.EJS_pathtodata;
    cfg.pathToData = window.EJS_pathtodata;
    cfg.dataPath = window.EJS_pathtodata;

    // Try disabling threads
    cfg.threads = false;

    if (defined(window.EJS_biosUrl)) cfg.biosUrl = window.EJS_biosUrl;
    if (defined(window.EJS_gameID)) cfg.gameId = window.EJS_gameID;
    if (defined(window.EJS_gameParentUrl)) cfg.gameParentUrl = window.EJS_gameParentUrl;
    if (defined(window.EJS_gamePatchUrl)) cfg.gamePatchUrl = window.EJS_gamePatchUrl;

    cfg.onsavestate = null;
    cfg.onloadstate = null;
    if (defined(window.EJS_onSaveState)) cfg.onsavestate = window.EJS_onSaveState;
    if (defined(window.EJS_onLoadState)) cfg.onloadstate = window.EJS_onLoadState;

    if (defined(window.EJS_lightgun)) cfg.lightgun = window.EJS_lightgun;
    if (defined(window.EJS_mouse)) cfg.mouse = window.EJS_mouse;
    if (defined(window.EJS_multitap)) cfg.multitap = window.EJS_multitap;

    if (defined(window.EJS_playerName)) cfg.playerName = window.EJS_playerName;
    if (defined(window.EJS_cheats)) cfg.cheats = window.EJS_cheats;
    if (defined(window.EJS_color)) cfg.color = window.EJS_color;

    return cfg;
  }

  // Try to find the constructor after emulator.js loads.
  function pickCtor() {
    var ctor = null;

    ctor = window.EJS;
    if (ctor && typeof ctor === 'object' && typeof ctor.default === 'function') ctor = ctor.default;
    if (typeof ctor === 'function') return ctor;

    var alt = window.EmulatorJS || window.Emulator || window.EJS_Emulator;
    if (alt && typeof alt === 'object' && typeof alt.default === 'function') alt = alt.default;
    if (typeof alt === 'function') return alt;

    return null;
  }

  function loadScript(src, timeoutMs) {
    timeoutMs = timeoutMs || 20000;
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
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = './';
    }

    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);
    safeLog('Path to data is set to ' + window.EJS_pathtodata);
    dlog('Normalized EJS_pathtodata:', window.EJS_pathtodata);

    assertRequiredGlobals();

    // IMPORTANT: Use a stable URL for mainScriptUrlOrBlob without query params for some builds
    var emuUrlNoQuery = window.EJS_pathtodata + 'emulator.js';
    var emuUrl = emuUrlNoQuery + '?v=0.4.23';

    // Emscripten Module hints
    try {
      window.Module = window.Module || {};

      // Log every locateFile request and force it to your data folder
      window.Module.locateFile = function (path, prefix) {
        var out = window.EJS_pathtodata + path;
        dlog('Module.locateFile:', { path: path, prefix: prefix, out: out });
        return out;
      };

      // This is critical for worker resolution when script is loaded dynamically
      window.Module.mainScriptUrlOrBlob = emuUrlNoQuery;
      dlog('Module.mainScriptUrlOrBlob set to:', window.Module.mainScriptUrlOrBlob);

      // Pipe prints
      window.Module.print = function () { safeLog.apply(null, arguments); };
      window.Module.printErr = function () { safeError.apply(null, arguments); };

      // If the build uses these, they help too (harmless if ignored)
      window.Module.noInitialRun = false;
      window.Module.locateFilePrefix = window.EJS_pathtodata;
    } catch (e) {
      derror('Failed to configure Module hints:', e);
    }

    // Load emulator.js
    try {
      dlog('Loading emulator.js:', emuUrl);
      await loadScript(emuUrl);
      dlog('Loaded emulator.js OK');
    } catch (e) {
      safeError('Failed to load emulator.js:', emuUrl, e);
      throw new Error('emulator.js failed to load: ' + emuUrl);
    }

    // Give emulator.js a moment to attach globals
    var ctor = null;
    for (var i = 0; i < 60; i++) {
      ctor = pickCtor();
      if (typeof ctor === 'function') break;
      await new Promise(function (r) { setTimeout(r, 25); });
    }

    if (typeof ctor !== 'function') {
      safeError('EJS constructor missing after emulator.js load. URL:', emuUrl);
      safeError('typeof window.EJS:', typeof window.EJS);
      safeError('typeof window.EmulatorJS:', typeof window.EmulatorJS);
      safeError('typeof window.Emulator:', typeof window.Emulator);
      throw new TypeError('EJS is not a constructor (missing)');
    }

    dlog('Picked constructor:', ctor && ctor.name ? ctor.name : '(anonymous function)');

    var cfg = buildCfg();
    dlog('Final cfg:', cfg);

    var inst = new ctor(window.EJS_player, cfg);
    window.EJS_emulator = inst;

    if (defined(window.EJS_onGameStart) && inst && typeof inst.on === 'function') {
      inst.on('start-game', window.EJS_onGameStart);
    }
  }

  start().catch(function (e) {
    safeError('loader.js fatal error:', e);
    derror('loader.js fatal error:', e && e.stack ? e.stack : e);
  });
})();