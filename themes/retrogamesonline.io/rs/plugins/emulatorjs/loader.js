(function () {
  'use strict';

  // -------------------------------------------------
  // DIAGNOSTIC MODE
  // -------------------------------------------------
  // Set to false once stable.
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
    return url && url.endsWith('/') ? url : (url + '/');
  }

  // Helpful crash logging
  window.addEventListener('error', function (ev) {
    try {
      safeError('window.error:', ev && (ev.message || ev.type), ev && ev.filename, ev && ev.lineno, ev && ev.colno, ev && ev.error);
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', function (ev) {
    try { safeError('unhandledrejection:', ev && ev.reason); } catch (e) {}
  });

  function normalizeBasePath(input) {
    var raw = isString(input) && input.length ? input : './';

    if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0) return ensureTrailingSlash(raw);
    if (raw.indexOf('//') === 0) return ensureTrailingSlash(window.location.protocol + raw);
    if (raw.indexOf('/') === 0) return ensureTrailingSlash(window.location.protocol + '//' + window.location.host + raw);

    try {
      var abs = new URL(raw, window.location.href).href;
      return ensureTrailingSlash(abs);
    } catch (e) {
      return window.location.protocol + '//' + window.location.host + '/';
    }
  }

  // -------------------------------------------------
  // Blob head-info behavior for EJS_gameUrl=blob:
  // -------------------------------------------------
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

  // Build the config object from EJS_* globals
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

  // Make sure biosUrl is absolute if it is relative.
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
  // Fix: "Attempting to create a Worker from an empty source."
  // -------------------------------------------------
  // IMPORTANT CHANGE vs last version:
  // Your Worker blob is still ending up "empty" at runtime, but we did not catch it because:
  // - Some builds create a non-0-byte Blob that STILL evaluates to an empty script in Firefox, or
  // - The blob URL is created in a way we cannot observe with size metadata, or
  // - The blob is revoked / invalid by the time Worker loads it.
  //
  // This version fixes it safely by:
  // 1) Tracking createObjectURL metadata when possible
  // 2) ALSO probing the blob URL synchronously (XHR) right before Worker is created
  // 3) If the blob script is empty (or probe fails), we swap ONLY that worker for a bootstrap that importScripts() emulator.js
  //
  // This directly targets the warning you see after clicking Start Game.
  var URLObj = window.URL || window.webkitURL;
  var __ejs_blob_url_meta = new Map(); // blobUrl -> {size,type}
  var __EJS_EMU_MAIN_URL = null;       // set once pathtodata is normalized

  var RealCreateObjectURL = (URLObj && URLObj.createObjectURL) ? URLObj.createObjectURL.bind(URLObj) : null;
  var RealRevokeObjectURL = (URLObj && URLObj.revokeObjectURL) ? URLObj.revokeObjectURL.bind(URLObj) : null;

  if (RealCreateObjectURL && !URLObj.__ejs_blob_meta_installed) {
    URLObj.createObjectURL = function (obj) {
      var url = RealCreateObjectURL(obj);
      try {
        var isBlob = (typeof Blob !== 'undefined') && (obj instanceof Blob);
        if (isBlob && isString(url) && url.indexOf('blob:') === 0) {
          __ejs_blob_url_meta.set(url, {
            size: (obj && typeof obj.size === 'number') ? obj.size : 0,
            type: String((obj && obj.type) || '')
          });
        }
      } catch (e) {
        derror('createObjectURL meta wrapper error:', e);
      }
      return url;
    };

    if (RealRevokeObjectURL) {
      URLObj.revokeObjectURL = function (url) {
        try { __ejs_blob_url_meta.delete(String(url)); } catch (e) {}
        return RealRevokeObjectURL(url);
      };
    }

    URLObj.__ejs_blob_meta_installed = true;
    dlog('Installed URL.createObjectURL metadata tracker');
  }

  function probeBlobWorkerSourceSync(blobUrl) {
    // Returns { ok: boolean, length: number, status: number, error: any }
    // If ok is true and length is 0, it is an "empty source" situation.
    var out = { ok: false, length: 0, status: 0, error: null };
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', blobUrl, false); // sync on purpose, we are in Worker constructor path
      xhr.send(null);
      out.status = xhr.status || 0;
      var txt = xhr.responseText || '';
      out.length = txt.length;
      out.ok = true;
      return out;
    } catch (e) {
      out.error = e;
      return out;
    }
  }

  function makeBootstrapWorkerUrl() {
    // Must be non-empty script content
    // If we do not know emulator.js URL yet, do not attempt (return null).
    if (!__EJS_EMU_MAIN_URL) return null;
    try {
      var boot = 'importScripts("' + __EJS_EMU_MAIN_URL + '");';
      var fixed = new Blob([boot], { type: 'text/javascript' });
      return (window.URL || window.webkitURL).createObjectURL(fixed);
    } catch (e) {
      derror('Failed to create bootstrap worker blob:', e);
      return null;
    }
  }

  // Wrap Worker once, globally (so it also catches workers created after clicking Start Game)
  var RealWorker = window.Worker;
  if (RealWorker && !RealWorker.__ejs_wrapped) {
    function WrappedWorker(url, opts) {
      var shown = '';
      try { shown = String(url); } catch (e) { shown = '[unstringable]'; }

      try {
        dlog('Worker() called with:', { type: (typeof url), url: shown });

        // Only consider blob: URLs
        if (isString(shown) && shown.indexOf('blob:') === 0) {
          var meta = __ejs_blob_url_meta.get(shown) || null;

          // Probe the worker script content to see if Firefox will treat it as empty
          var probe = probeBlobWorkerSourceSync(shown);

          // Decide "empty" if:
          // - probe worked and length is 0, OR
          // - probe failed (often revoked/invalid blob), OR
          // - meta says size 0
          var isEmpty =
            (meta && meta.size === 0) ||
            (probe && probe.ok && probe.length === 0) ||
            (probe && !probe.ok);

          if (DIAG) {
            dlog('Worker(blob) meta+probe:', {
              meta: meta,
              probe: probe,
              decidedEmpty: isEmpty,
              emuMain: __EJS_EMU_MAIN_URL
            });
          }

          if (isEmpty) {
            // This is the exact warning path you see.
            dwarn('Empty Worker blob detected. Swapping to bootstrap importScripts(emulator.js).');

            var bootUrl = makeBootstrapWorkerUrl();
            if (bootUrl) {
              return new RealWorker(bootUrl, opts);
            } else {
              // If this happens, emulator.js URL was not set yet, which would be unexpected.
              // Fall back to original so we do not crash the page.
              dwarn('Bootstrap worker URL unavailable. Using original worker URL.');
            }
          }
        }
      } catch (e) {
        derror('Worker wrapper error:', e);
      }

      return new RealWorker(url, opts);
    }

    WrappedWorker.__ejs_wrapped = true;
    window.Worker = WrappedWorker;
    window.Worker.__ejs_wrapped = true;
    dlog('Installed Worker() wrapper (probe + empty-blob fix)');
  }

  async function start() {
    // Normalize EJS_pathtodata early
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = './';
    }

    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);
    safeLog('Path to data is set to ' + window.EJS_pathtodata);
    dlog('Normalized EJS_pathtodata:', window.EJS_pathtodata);

    assertRequiredGlobals();

    // Stable base URL without query
    var emuMainNoQuery = window.EJS_pathtodata + 'emulator.js';
    var emuUrl = emuMainNoQuery + '?v=0.4.23';

    // Set the global main URL used by the Worker bootstrap fixer
    __EJS_EMU_MAIN_URL = emuMainNoQuery;

    // -------------------------------------------------
    // Emscripten Module hints (set BEFORE emulator.js runs)
    // -------------------------------------------------
    try {
      window.Module = window.Module || {};

      window.Module.locateFile = function (path, prefix) {
        return window.EJS_pathtodata + path;
      };

      // Critical: tell Emscripten what the main script URL is
      window.Module.mainScriptUrlOrBlob = emuMainNoQuery;

      // Hard hints some builds look for
      window.Module.pthreadMainRuntimeThreadScript = emuMainNoQuery;
      window.Module.pthreadWorkerUrl = emuMainNoQuery;
      window.Module.pthreadWorkerFile = emuMainNoQuery;

      // Strongly discourage any pool creation
      window.Module.PTHREAD_POOL_SIZE = 0;
      window.Module.pthreadPoolSize = 0;

      window.Module.print = function () { safeLog.apply(null, arguments); };
      window.Module.printErr = function () { safeError.apply(null, arguments); };

      dlog('Module hints set. mainScriptUrlOrBlob:', window.Module.mainScriptUrlOrBlob);
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
    for (var i = 0; i < 80; i++) {
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

    // Make biosUrl absolute if provided and relative
    if (cfg && cfg.biosUrl) cfg.biosUrl = absolutizeMaybe(cfg.biosUrl);

    dlog('Final cfg:', cfg);

    // Create emulator instance
    var inst = new ctor(window.EJS_player, cfg);
    window.EJS_emulator = inst;

    // Optional hook
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