(function () {
  'use strict';

  // =================================================
  // EmulatorJS loader.js
  // Goal: stop Firefox "Attempting to create a Worker from an empty source"
  // and get past the Start button hang.
  //
  // Fix strategy:
  // 1) Wrap window.Worker so any Worker(blob:) is replaced with a bootstrap worker.
  // 2) The bootstrap worker installs the SAME Worker fix inside the worker scope
  //    (self.Worker + self.URL.createObjectURL), then imports:
  //      - the original blob worker script (if any)
  //      - emulator.js (ensures core is available)
  //
  // This covers nested workers created inside the first worker.
  // =================================================

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
  // Worker wrapper: replaces blob workers with a bootstrap
  // and installs the same fix inside the worker scope.
  // =================================================
  function installWorkerFix(emuMainNoQuery) {
    var URLObj = window.URL || window.webkitURL;
    var RealWorker = window.Worker;
    if (!RealWorker || RealWorker.__ejs_worker_fix_installed) return;

    function esc(str) {
      return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function makeBootstrapWorkerUrl(originalBlobUrl) {
      // The bootstrap is intentionally non-empty.
      // It also patches worker scope so nested workers are fixed too.
      var boot = ''
        + '(function(){\n'
        + '  try{\n'
        + '    var DIAG=' + (DIAG ? 'true' : 'false') + ';\n'
        + '    function log(){try{ if(DIAG) console.log.apply(console, arguments);}catch(e){} }\n'
        + '    var URLObj=self.URL||self.webkitURL;\n'
        + '    // Patch createObjectURL inside worker so empty blobs never happen\n'
        + '    if(URLObj && URLObj.createObjectURL && !URLObj.__ejs_worker_blob_fix){\n'
        + '      var realCOU=URLObj.createObjectURL.bind(URLObj);\n'
        + '      URLObj.createObjectURL=function(obj){\n'
        + '        try{\n'
        + '          if(typeof Blob!==\"undefined\" && obj instanceof Blob){\n'
        + '            var t=String(obj.type||\"\").toLowerCase();\n'
        + '            var isJS=(t.indexOf(\"javascript\")!==-1)||(t.indexOf(\"ecmascript\")!==-1)||(t.indexOf(\"text/plain\")!==-1)||(!t);\n'
        + '            if(isJS && obj.size===0){\n'
        + '              var fixed=new Blob([\"/* ejs worker non-empty */\\n\"], {type:\"text/javascript\"});\n'
        + '              return realCOU(fixed);\n'
        + '            }\n'
        + '          }\n'
        + '        }catch(e){}\n'
        + '        return realCOU(obj);\n'
        + '      };\n'
        + '      URLObj.__ejs_worker_blob_fix=true;\n'
        + '      log(\"[EJS-DIAG] worker: installed createObjectURL empty-blob fix\");\n'
        + '    }\n'
        + '    // Patch Worker inside worker so nested workers get bootstrapped too\n'
        + '    if(self.Worker && !self.Worker.__ejs_nested_fix){\n'
        + '      var RealW=self.Worker;\n'
        + '      self.Worker=function(u,o){\n'
        + '        var s=\"\"; try{s=String(u);}catch(e){s=\"\";}\n'
        + '        try{\n'
        + '          if(!s || s.indexOf(\"blob:\")===0){\n'
        + '            var innerBoot=\"try{importScripts(\\\"' + esc(originalBlobUrl) + '\\\");}catch(e){}\\n\"+\n'
        + '                         \"try{importScripts(\\\"' + esc(emuMainNoQuery) + '\\\");}catch(e){}\\n\";\n'
        + '            var b=new Blob([innerBoot], {type:\"text/javascript\"});\n'
        + '            var bu=(URLObj&&URLObj.createObjectURL)?URLObj.createObjectURL(b):u;\n'
        + '            return new RealW(bu, o);\n'
        + '          }\n'
        + '        }catch(e){}\n'
        + '        return new RealW(u,o);\n'
        + '      };\n'
        + '      self.Worker.__ejs_nested_fix=true;\n'
        + '      log(\"[EJS-DIAG] worker: installed nested Worker fix\");\n'
        + '    }\n'
        + '  }catch(e){}\n'
        + '})();\n'
        // Now run the original worker logic first (if any), then emulator.js.
        + 'try{importScripts("' + esc(originalBlobUrl) + '");}catch(e){}\n'
        + 'try{importScripts("' + esc(emuMainNoQuery) + '");}catch(e){}\n';

      var blob = new Blob([boot], { type: 'text/javascript' });
      return URLObj.createObjectURL(blob);
    }

    function WrappedWorker(url, opts) {
      var shown = '';
      try { shown = String(url); } catch (e) { shown = ''; }

      if (DIAG) dlog('Worker() called with:', { type: (typeof url), url: shown });

      try {
        // Intercept blob workers, and also intercept empty-string workers defensively.
        if (!shown || (isString(shown) && shown.indexOf('blob:') === 0)) {
          var bootUrl = makeBootstrapWorkerUrl(shown || 'blob:');
          dwarn('Worker(blob/empty) replaced with bootstrap.', { original: shown || '(empty)', bootstrap: bootUrl });
          return new RealWorker(bootUrl, opts);
        }
      } catch (e) {
        derror('Worker wrapper error:', e);
      }

      return new RealWorker(url, opts);
    }

    WrappedWorker.__ejs_worker_fix_installed = true;
    window.Worker = WrappedWorker;
    RealWorker.__ejs_worker_fix_installed = true;

    dlog('Installed Worker() wrapper (page + nested-worker fix)');
  }

  async function start() {
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = './';
    }

    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);
    safeLog('Path to data is set to ' + window.EJS_pathtodata);
    dlog('Normalized EJS_pathtodata:', window.EJS_pathtodata);

    assertRequiredGlobals();

    var emuMainNoQuery = window.EJS_pathtodata + 'emulator.js';

    // Install Worker fix before emulator.js runs
    installWorkerFix(emuMainNoQuery);

    // Emscripten Module hints set before emulator.js
    try {
      window.Module = window.Module || {};

      window.Module.locateFile = function (path, prefix) {
        return window.EJS_pathtodata + path;
      };

      window.Module.mainScriptUrlOrBlob = emuMainNoQuery;

      // discourage pools
      window.Module.PTHREAD_POOL_SIZE = 0;
      window.Module.pthreadPoolSize = 0;

      // some builds look for these
      window.Module.pthreadMainRuntimeThreadScript = emuMainNoQuery;
      window.Module.pthreadWorkerUrl = emuMainNoQuery;
      window.Module.pthreadWorkerFile = emuMainNoQuery;

      window.Module.print = function () { safeLog.apply(null, arguments); };
      window.Module.printErr = function () { safeError.apply(null, arguments); };

      dlog('Module hints set. mainScriptUrlOrBlob:', window.Module.mainScriptUrlOrBlob);
    } catch (e) {
      derror('Failed to configure Module hints:', e);
    }

    // Load emulator.js with cache bust (keeps your v=0.4.23 but avoids stale worker code)
    var emuUrl = emuMainNoQuery + '?v=0.4.23&cb=' + Date.now();

    try {
      dlog('Loading emulator.js:', emuUrl);
      await loadScript(emuUrl);
      dlog('Loaded emulator.js OK');
    } catch (e) {
      safeError('Failed to load emulator.js:', emuUrl, e);
      throw new Error('emulator.js failed to load: ' + emuUrl);
    }

    var ctor = null;
    for (var i = 0; i < 160; i++) {
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

    // Force off again
    cfg.threads = false;
    cfg.pthreads = false;
    cfg.threading = false;

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
    derror('loader.js fatal error stack:', e && e.stack ? e && e.stack : e);
  });
})();