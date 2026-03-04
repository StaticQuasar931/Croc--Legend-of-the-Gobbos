(function () {
  'use strict';


  // -------------------------------------------------
  // DIAGNOSTIC MODE
  // -------------------------------------------------
  var DIAG = true;

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

  function buildCfg() {
    var cfg = {};
    cfg.gameUrl = window.EJS_gameUrl;
    cfg.system = window.EJS_core;

    cfg.pathtodata = window.EJS_pathtodata;
    cfg.pathToData = window.EJS_pathtodata;
    cfg.dataPath = window.EJS_pathtodata;

    // Hard disable threads (requested by you earlier)
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

  // =================================================
  // CORE FIX: prevent empty JS blobs (worker scripts)
  // =================================================
  var __EJS_EMU_MAIN_URL = null;
  var __EJS_BLOB_PATCHED = false;

  function isJsMime(typeStr) {
    var t = String(typeStr || '').toLowerCase();
    return (
      t.indexOf('javascript') !== -1 ||
      t.indexOf('ecmascript') !== -1 ||
      t.indexOf('application/x-javascript') !== -1 ||
      t.indexOf('text/plain') !== -1
    );
  }

  function partsToText(parts) {
    // Best-effort: join string-ish parts only.
    // If parts are non-strings (ArrayBuffer, etc.), we treat it as non-empty.
    try {
      if (!parts || !parts.length) return '';
      var s = '';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p === null || typeof p === 'undefined') continue;
        if (typeof p === 'string') {
          s += p;
          continue;
        }
        // If it is not a string, we assume it's meaningful binary content
        // and do NOT classify it as empty.
        return '__non_string_parts__';
      }
      return s;
    } catch (e) {
      return '__error__';
    }
  }

  function installBlobEmptyJsFix() {
    if (__EJS_BLOB_PATCHED) return;
    if (typeof Blob === 'undefined') return;

    var RealBlob = Blob;

    // Replace global Blob constructor
    // This catches the exact moment EmulatorJS tries to build a worker script Blob.
    Blob = function (parts, options) {
      try {
        var opt = options || {};
        var type = opt.type || '';
        var jsLike = isJsMime(type);

        if (jsLike) {
          var txt = partsToText(parts);

          // If the "code" is empty or whitespace only, replace it with a bootstrap.
          // Note: if txt is '__non_string_parts__', we do not touch it.
          if (txt !== '__non_string_parts__' && txt !== '__error__') {
            var trimmed = String(txt || '').replace(/\uFEFF/g, '').trim();
            if (trimmed.length === 0 && __EJS_EMU_MAIN_URL) {
              // This is the exact scenario that triggers the Firefox warning.
              var boot = 'importScripts("' + __EJS_EMU_MAIN_URL + '");';
              dwarn('Detected empty JS Blob. Replacing with Worker bootstrap importScripts(emulator.js).', {
                type: type,
                emulator: __EJS_EMU_MAIN_URL
              });
              return new RealBlob([boot], { type: 'text/javascript' });
            }
          }
        }
      } catch (e) {
        derror('Blob patch error:', e);
      }

      return new RealBlob(parts, options);
    };

    // Preserve prototype/props so instanceof Blob keeps behaving
    Blob.prototype = RealBlob.prototype;
    try { Object.setPrototypeOf(Blob, RealBlob); } catch (e) {}

    __EJS_BLOB_PATCHED = true;
    dlog('Installed Blob() empty-JS fix');
  }

  // -------------------------------------------------
  // Optional DIAG: Worker wrapper logs only
  // -------------------------------------------------
  function installWorkerLogger() {
    var RealWorker = window.Worker;
    if (!RealWorker || RealWorker.__ejs_logged) return;

    function WrappedWorker(url, opts) {
      try {
        var shown = '';
        try { shown = String(url); } catch (e) { shown = '[unstringable]'; }
        dlog('Worker() called with:', { type: (typeof url), url: shown });
      } catch (e) {}
      return new RealWorker(url, opts);
    }

    WrappedWorker.__ejs_logged = true;
    window.Worker = WrappedWorker;
    window.Worker.__ejs_logged = true;

    dlog('Installed Worker() logger');
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

    var emuMainNoQuery = window.EJS_pathtodata + 'emulator.js';
    var emuUrl = emuMainNoQuery + '?v=0.4.23';

    // Set main URL for bootstrap
    __EJS_EMU_MAIN_URL = emuMainNoQuery;

    // Install fixes before emulator.js runs
    installBlobEmptyJsFix();
    installWorkerLogger();

    // -------------------------------------------------
    // Emscripten Module hints (set BEFORE emulator.js runs)
    // -------------------------------------------------
    try {
      window.Module = window.Module || {};

      window.Module.locateFile = function (path, prefix) {
        return window.EJS_pathtodata + path;
      };

      window.Module.mainScriptUrlOrBlob = emuMainNoQuery;

      // Some builds look for these
      window.Module.pthreadMainRuntimeThreadScript = emuMainNoQuery;
      window.Module.pthreadWorkerUrl = emuMainNoQuery;
      window.Module.pthreadWorkerFile = emuMainNoQuery;

      // Discourage pools
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

    // Wait for constructor
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
    if (cfg && cfg.biosUrl) cfg.biosUrl = absolutizeMaybe(cfg.biosUrl);

    dlog('Final cfg:', cfg);

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