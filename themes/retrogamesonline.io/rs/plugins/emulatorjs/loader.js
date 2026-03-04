(function () {
  'use strict';

  // =================================================
  // EmulatorJS loader.js (robust Worker empty-source fix)
  // =================================================
  // Drop this file here (replace the existing one):
  // /themes/retrogamesonline.io/rs/plugins/emulatorjs/loader.js
  //
  // Why this version:
  // Firefox shows "Attempting to create a Worker from an empty source"
  // when EmulatorJS tries to start the emulation Worker from a Blob URL
  // whose script content is empty (or effectively empty).
  //
  // This loader installs a safe Worker wrapper:
  // - It probes blob: URLs synchronously (only when a Worker is being created)
  // - If the blob script is empty (or effectively empty), it replaces it with
  //   a non-empty bootstrap that importScripts() emulator.js
  //
  // This aims to get you past the start button hang and actually boot the core.

  // Set true for extra console logging
  var DIAG = true;

  // -----------------------------
  // Helpers
  // -----------------------------
  function isString(v) { return typeof v === 'string'; }
  function defined(v) { return typeof v !== 'undefined'; }

  function safeLog()  { try { console.log.apply(console, arguments); } catch (e) {} }
  function safeWarn() { try { console.warn.apply(console, arguments); } catch (e) {} }
  function safeError(){ try { console.error.apply(console, arguments); } catch (e) {} }

  function dlog()  { if (!DIAG) return; safeLog.apply(null, ['[EJS-DIAG]'].concat([].slice.call(arguments))); }
  function dwarn() { if (!DIAG) return; safeWarn.apply(null, ['[EJS-DIAG]'].concat([].slice.call(arguments))); }
  function derror(){ if (!DIAG) return; safeError.apply(null, ['[EJS-DIAG]'].concat([].slice.call(arguments))); }

  function ensureTrailingSlash(url) {
    if (!isString(url)) return url;
    return url.endsWith('/') ? url : (url + '/');
  }

  function normalizeBasePath(input) {
    var raw = isString(input) && input.length ? input : './';

    if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0) return ensureTrailingSlash(raw);
    if (raw.indexOf('//') === 0) return ensureTrailingSlash(window.location.protocol + raw);
    if (raw.indexOf('/') === 0) return ensureTrailingSlash(window.location.protocol + '//' + window.location.host + raw);

    try {
      return ensureTrailingSlash(new URL(raw, window.location.href).href);
    } catch (e) {
      return window.location.protocol + '//' + window.location.host + '/';
    }
  }

  // Crash logging
  window.addEventListener('error', function (ev) {
    try {
      safeError('window.error:', ev && (ev.message || ev.type), ev && ev.filename, ev && ev.lineno, ev && ev.colno, ev && ev.error);
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', function (ev) {
    try { safeError('unhandledrejection:', ev && ev.reason); } catch (e) {}
  });

  // -------------------------------------------------
  // Blob head-info behavior for EJS_gameUrl=blob:
  // -------------------------------------------------
  // Some EmulatorJS builds may try to HEAD the game URL.
  // For blob: URLs, we provide a safe "fake HEAD" using fetch(blob) to get size/type.
  window.getHeadGameInfo = function (normalFunc, url) {
    try {
      if (typeof url !== "string" || url.indexOf("blob:") !== 0) return normalFunc(url, {});
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

  // Build config from EJS_* globals
  function buildCfg() {
    var cfg = {};

    cfg.gameUrl = window.EJS_gameUrl;
    cfg.system = window.EJS_core;

    cfg.pathtodata = window.EJS_pathtodata;
    cfg.pathToData = window.EJS_pathtodata;
    cfg.dataPath = window.EJS_pathtodata;

    // Hard disable threads
    cfg.threads = false;
    cfg.pthreads = false;
    cfg.threading = false;

    // Some builds check these globals too
    if (defined(window.EJS_threads)) cfg.threads = !!window.EJS_threads;
    if (defined(window.EJS_pthreads)) cfg.pthreads = !!window.EJS_pthreads;

    // You want them disabled no matter what
    cfg.threads = false;
    cfg.pthreads = false;
    cfg.threading = false;

    if (defined(window.EJS_biosUrl)) cfg.biosUrl = window.EJS_biosUrl;

    cfg.onsavestate = null;
    cfg.onloadstate = null;
    if (defined(window.EJS_onSaveState)) cfg.onsavestate = window.EJS_onSaveState;
    if (defined(window.EJS_onLoadState)) cfg.onloadstate = window.EJS_onLoadState;

    return cfg;
  }

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
    timeoutMs = timeoutMs || 25000;
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

  function absolutizeMaybe(url) {
    try {
      if (!isString(url) || !url.trim().length) return url;
      if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0 || url.indexOf('blob:') === 0) return url;
      return new URL(url, window.location.href).href;
    } catch (e) {
      return url;
    }
  }

  // -------------------------------------------------
  // Worker empty-source fix (Firefox)
  // -------------------------------------------------
  // We probe the blob URL the moment Worker(blobUrl) is called.
  // If the script is empty after stripping whitespace and comments,
  // we replace it with bootstrap: importScripts(emulator.js)
  //
  // This uses sync XHR only on the "start-game" path, not during page load.
  // You will still see a deprecation warning about sync XHR, but that warning
  // is far better than the emulator never starting.
  function installWorkerEmptySourceFix(emuMainNoQuery) {
    var URLObj = window.URL || window.webkitURL;
    var RealWorker = window.Worker;
    if (!RealWorker) return;

    if (RealWorker.__ejs_worker_fix_installed) return;

    function stripForEmptyCheck(src) {
      try {
        if (!isString(src)) return '';
        // remove BOM
        src = src.replace(/^\uFEFF/, '');
        // remove block comments
        src = src.replace(/\/\*[\s\S]*?\*\//g, '');
        // remove line comments
        src = src.replace(/\/\/[^\n\r]*/g, '');
        // remove whitespace and semicolons
        src = src.replace(/[\s;]+/g, '');
        return src;
      } catch (e) {
        return '';
      }
    }

    function syncGetText(url) {
      // Returns { ok:bool, status:number, text:string }
      var out = { ok: false, status: 0, text: '' };
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send(null);
        out.status = xhr.status || 0;
        out.ok = (out.status >= 200 && out.status < 300) || out.status === 0; // blob: often reports 0
        out.text = xhr.responseText || '';
        return out;
      } catch (e) {
        return out;
      }
    }

    function makeBootstrapUrl() {
      try {
        var boot =
          'try{importScripts("' + emuMainNoQuery + '");}catch(e){}';
        var blob = new Blob([boot], { type: 'text/javascript' });
        return URLObj.createObjectURL(blob);
      } catch (e) {
        return null;
      }
    }

    function WrappedWorker(url, opts) {
      var shown = '';
      try { shown = String(url); } catch (e) { shown = '[unstringable]'; }

      if (DIAG) dlog('Worker() called with:', { type: (typeof url), url: shown });

      try {
        if (isString(shown) && shown.indexOf('blob:') === 0) {
          var probe = syncGetText(shown);

          var trimmed = stripForEmptyCheck(probe.text);
          var isEffectivelyEmpty = !trimmed || trimmed.length === 0;

          if (DIAG) {
            dlog('Worker(blob) probe:', {
              status: probe.status,
              bytes: (probe.text ? probe.text.length : 0),
              decidedEmpty: isEffectivelyEmpty,
              emuMain: emuMainNoQuery
            });
          }

          if (isEffectivelyEmpty) {
            dwarn('Empty Worker source detected. Replacing Worker script with emulator.js bootstrap.', shown);
            var bootUrl = makeBootstrapUrl();
            if (bootUrl) return new RealWorker(bootUrl, opts);
          }
        }
      } catch (e) {
        derror('Worker wrapper error:', e);
      }

      return new RealWorker(url, opts);
    }

    WrappedWorker.__ejs_worker_fix_installed = true;
    window.Worker = WrappedWorker;
    RealWorker.__ejs_worker_fix_installed = true;

    dlog('Installed Worker() wrapper (empty-source fix)');
  }

  async function start() {
    // Normalize path early
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = './';
    }
    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);
    safeLog('Path to data is set to ' + window.EJS_pathtodata);
    dlog('Normalized EJS_pathtodata:', window.EJS_pathtodata);

    assertRequiredGlobals();

    // Base URLs
    var emuMainNoQuery = window.EJS_pathtodata + 'emulator.js';

    // Install Worker fix before emulator.js loads and before the start button triggers core startup
    installWorkerEmptySourceFix(emuMainNoQuery);

    // Emscripten Module hints must be set BEFORE emulator.js runs
    try {
      window.Module = window.Module || {};

      window.Module.locateFile = function (path, prefix) {
        return window.EJS_pathtodata + path;
      };

      window.Module.mainScriptUrlOrBlob = emuMainNoQuery;

      // discourage pthreads
      window.Module.PTHREAD_POOL_SIZE = 0;
      window.Module.pthreadPoolSize = 0;

      // some builds read these
      window.Module.pthreadMainRuntimeThreadScript = emuMainNoQuery;
      window.Module.pthreadWorkerUrl = emuMainNoQuery;
      window.Module.pthreadWorkerFile = emuMainNoQuery;

      window.Module.print = function () { safeLog.apply(null, arguments); };
      window.Module.printErr = function () { safeError.apply(null, arguments); };

      dlog('Module hints set. mainScriptUrlOrBlob:', window.Module.mainScriptUrlOrBlob);
    } catch (e) {
      derror('Failed to configure Module hints:', e);
    }

    // Cache bust so you do not get stuck on old emulator.js
    var emuUrl = emuMainNoQuery + '?v=0.4.23&cb=' + Date.now();

    // Load emulator.js
    try {
      dlog('Loading emulator.js:', emuUrl);
      await loadScript(emuUrl);
      dlog('Loaded emulator.js OK');
    } catch (e) {
      safeError('Failed to load emulator.js:', emuUrl, e);
      throw new Error('emulator.js failed to load: ' + emuUrl);
    }

    // Wait for constructor
    var ctor = null;
    for (var i = 0; i < 120; i++) {
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

    dlog('Picked constructor:', ctor && ctor.name ? ctor.name : '(anonymous)');

    var cfg = buildCfg();

    if (cfg && cfg.biosUrl) cfg.biosUrl = absolutizeMaybe(cfg.biosUrl);

    // Force thread flags off in final cfg too
    cfg.threads = false;
    cfg.pthreads = false;
    cfg.threading = false;

    dlog('Final cfg:', cfg);

    // Create emulator instance
    var inst = new ctor(window.EJS_player, cfg);
    window.EJS_emulator = inst;

    if (defined(window.EJS_onGameStart) && inst && typeof inst.on === 'function') {
      inst.on('start-game', window.EJS_onGameStart);
    }

    dlog('Emulator instance created OK');
  }

  start().catch(function (e) {
    safeError('loader.js fatal error:', e);
    derror('loader.js fatal error stack:', e && e.stack ? e.stack : e);
  });
})();