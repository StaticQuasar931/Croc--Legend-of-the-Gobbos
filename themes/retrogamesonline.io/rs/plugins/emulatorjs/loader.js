(function () {
  "use strict";

  // =================================================
  // EmulatorJS loader.js (Firefox worker revoke race fix)
  // Path: /themes/retrogamesonline.io/rs/plugins/emulatorjs/loader.js
  //
  // Primary fix:
  // - Firefox can show "Attempting to create a Worker from an empty source"
  //   when a blob: worker URL is revoked too quickly after Worker() starts.
  // - We wrap URL.revokeObjectURL to DELAY revokes for blob URLs recently used by Worker().
  // - We also apply the same protection inside the worker for nested workers.
  //
  // Secondary safety:
  // - createObjectURL: replace 0-byte JS blobs with a non-empty stub
  // - Worker("") safety: replace empty-string worker URLs with a stub
  // =================================================

  var DIAG = true;

  function isString(v) { return typeof v === "string"; }
  function defined(v) { return typeof v !== "undefined"; }

  function safeLog() { try { console.log.apply(console, arguments); } catch (e) {} }
  function safeWarn() { try { console.warn.apply(console, arguments); } catch (e) {} }
  function safeError() { try { console.error.apply(console, arguments); } catch (e) {} }

  function dlog() { if (!DIAG) return; safeLog.apply(null, ["[EJS-DIAG]"].concat([].slice.call(arguments))); }
  function dwarn() { if (!DIAG) return; safeWarn.apply(null, ["[EJS-DIAG]"].concat([].slice.call(arguments))); }
  function derror() { if (!DIAG) return; safeError.apply(null, ["[EJS-DIAG]"].concat([].slice.call(arguments))); }

  function ensureTrailingSlash(url) {
    if (!isString(url)) return url;
    return url.endsWith("/") ? url : (url + "/");
  }

  function normalizeBasePath(input) {
    var raw = (isString(input) && input.length) ? input : "./";

    if (raw.indexOf("http://") === 0 || raw.indexOf("https://") === 0) return ensureTrailingSlash(raw);
    if (raw.indexOf("//") === 0) return ensureTrailingSlash(window.location.protocol + raw);
    if (raw.indexOf("/") === 0) return ensureTrailingSlash(window.location.protocol + "//" + window.location.host + raw);

    try {
      return ensureTrailingSlash(new URL(raw, window.location.href).href);
    } catch (e) {
      return window.location.protocol + "//" + window.location.host + "/";
    }
  }

  window.addEventListener("error", function (ev) {
    try {
      safeError("window.error:", ev && (ev.message || ev.type), ev && ev.filename, ev && ev.lineno, ev && ev.colno, ev && ev.error);
    } catch (e) {}
  });

  window.addEventListener("unhandledrejection", function (ev) {
    try { safeError("unhandledrejection:", ev && ev.reason); } catch (e) {}
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
          headers: { "content-length": "0", "content-type": "application/octet-stream" }
        };
      }
    })();
  };

  function assertRequiredGlobals() {
    var missing = [];
    if (!defined(window.EJS_player)) missing.push("EJS_player");
    if (!defined(window.EJS_core)) missing.push("EJS_core");
    if (!defined(window.EJS_gameUrl)) missing.push("EJS_gameUrl");
    if (missing.length) {
      safeError("loader.js missing required globals:", missing.join(", "));
      throw new Error("Missing required globals: " + missing.join(", "));
    }
  }

  function buildCfg() {
    var cfg = {};

    cfg.gameUrl = window.EJS_gameUrl;
    cfg.system = window.EJS_core;

    cfg.pathtodata = window.EJS_pathtodata;
    cfg.pathToData = window.EJS_pathtodata;
    cfg.dataPath = window.EJS_pathtodata;

    // Hard disable threads in every known flag
    cfg.threads = false;
    cfg.pthreads = false;
    cfg.threading = false;

    if (defined(window.EJS_biosUrl)) cfg.biosUrl = window.EJS_biosUrl;

    cfg.onsavestate = defined(window.EJS_onSaveState) ? window.EJS_onSaveState : null;
    cfg.onloadstate = defined(window.EJS_onLoadState) ? window.EJS_onLoadState : null;

    return cfg;
  }

  function pickCtor() {
    var ctor = window.EJS;
    if (ctor && typeof ctor === "object" && typeof ctor.default === "function") ctor = ctor.default;
    if (typeof ctor === "function") return ctor;

    var alt = window.EmulatorJS || window.Emulator || window.EJS_Emulator;
    if (alt && typeof alt === "object" && typeof alt.default === "function") alt = alt.default;
    if (typeof alt === "function") return alt;

    return null;
  }

  function loadScript(src, timeoutMs) {
    timeoutMs = timeoutMs || 25000;
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.async = false;
      s.defer = false;
      s.src = src;
      s.crossOrigin = "anonymous";

      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        try { s.remove(); } catch (e) {}
        reject(new Error("Timed out loading script: " + src));
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
        reject(e || new Error("Failed to load script: " + src));
      };

      var first = document.getElementsByTagName("script")[0];
      if (first && first.parentNode) first.parentNode.insertBefore(s, first);
      else document.head.appendChild(s);
    });
  }

  function absolutizeMaybe(url) {
    try {
      if (!isString(url) || !url.trim().length) return url;
      if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0 || url.indexOf("blob:") === 0) return url;
      return new URL(url, window.location.href).href;
    } catch (e) {
      return url;
    }
  }

  // -------------------------------------------------
  // 1) createObjectURL fix: 0-byte JS blobs become non-empty
  // -------------------------------------------------
  function installCreateObjectUrlFix() {
    var URLObj = window.URL || window.webkitURL;
    if (!URLObj || !URLObj.createObjectURL || URLObj.__ejs_createObjectURL_fixed) return;

    var real = URLObj.createObjectURL.bind(URLObj);

    URLObj.createObjectURL = function (obj) {
      try {
        var isBlob = (typeof Blob !== "undefined") && (obj instanceof Blob);
        if (isBlob) {
          var t = String(obj.type || "").toLowerCase();
          var isJS = (t.indexOf("javascript") !== -1) || (t.indexOf("ecmascript") !== -1) || (t.indexOf("text/plain") !== -1);
          if (isJS && obj.size === 0) {
            var fixed = new Blob(["/* ejs non-empty stub */"], { type: "text/javascript" });
            return real(fixed);
          }
        }
      } catch (e) {}
      return real(obj);
    };

    URLObj.__ejs_createObjectURL_fixed = true;
    dlog("Installed URL.createObjectURL 0-byte JS blob fix");
  }

  // -------------------------------------------------
  // 2) revokeObjectURL fix: delay revokes for worker-used blob URLs
  // -------------------------------------------------
  function installRevokeProtection() {
    var URLObj = window.URL || window.webkitURL;
    if (!URLObj || !URLObj.revokeObjectURL || URLObj.__ejs_revoke_protect_installed) return;

    var realRevoke = URLObj.revokeObjectURL.bind(URLObj);

    // blobUrl -> expireTime (ms)
    var protectUntil = new Map();

    function protect(url, ms) {
      try {
        if (!isString(url) || url.indexOf("blob:") !== 0) return;
        var until = Date.now() + (ms || 30000);
        protectUntil.set(url, until);
      } catch (e) {}
    }

    function isProtected(url) {
      try {
        var u = protectUntil.get(url);
        if (!u) return false;
        if (Date.now() > u) { protectUntil.delete(url); return false; }
        return true;
      } catch (e) {
        return false;
      }
    }

    // Expose for Worker wrapper
    window.__ejsProtectBlobUrl = protect;

    URLObj.revokeObjectURL = function (url) {
      var u = "";
      try { u = String(url); } catch (e) { u = ""; }

      // If EmulatorJS revokes immediately, Firefox worker fetch can see "empty source".
      if (isProtected(u)) {
        if (DIAG) dwarn("Delayed revokeObjectURL for protected worker blob:", u);
        setTimeout(function () { try { realRevoke(u); } catch (e) {} }, 35000);
        return;
      }

      return realRevoke(url);
    };

    URLObj.__ejs_revoke_protect_installed = true;
    dlog("Installed URL.revokeObjectURL protection (delays worker blob revokes)");
  }

  // -------------------------------------------------
  // Worker bootstrap that patches INSIDE the worker:
  // - createObjectURL 0-byte JS fix
  // - revokeObjectURL protection for nested worker blobs
  // - Worker("") guard
  // then importScripts(emulator.js)
  // -------------------------------------------------
  function makeWorkerBootstrap(emuMainNoQuery) {
    return [
      "(function(){",
      "  try{",
      "    var DIAG=true;",
      "    function log(){try{if(DIAG && self.console && self.console.log) self.console.log.apply(self.console, arguments);}catch(e){}}",
      "    function warn(){try{if(DIAG && self.console && self.console.warn) self.console.warn.apply(self.console, arguments);}catch(e){}}",
      "",
      "    var URLObj = self.URL || self.webkitURL;",
      "    if(URLObj && URLObj.createObjectURL && !URLObj.__ejs_createObjectURL_fixed){",
      "      var realCOU = URLObj.createObjectURL.bind(URLObj);",
      "      URLObj.createObjectURL = function(obj){",
      "        try{",
      "          var isBlob = (typeof Blob!=='undefined') && (obj instanceof Blob);",
      "          if(isBlob){",
      "            var t = String(obj.type||'').toLowerCase();",
      "            var isJS = (t.indexOf('javascript')!==-1)||(t.indexOf('ecmascript')!==-1)||(t.indexOf('text/plain')!==-1);",
      "            if(isJS && obj.size===0){",
      "              var fixed = new Blob(['/* ejs non-empty stub */'], {type:'text/javascript'});",
      "              return realCOU(fixed);",
      "            }",
      "          }",
      "        }catch(e){}",
      "        return realCOU(obj);",
      "      };",
      "      URLObj.__ejs_createObjectURL_fixed=true;",
      "      log('[EJS-DIAG] worker: installed createObjectURL 0-byte fix');",
      "    }",
      "",
      "    // Protect nested worker blob URLs from early revoke",
      "    if(URLObj && URLObj.revokeObjectURL && !URLObj.__ejs_revoke_protect_installed){",
      "      var realRev = URLObj.revokeObjectURL.bind(URLObj);",
      "      var protectUntil = new Map();",
      "      function protect(u, ms){",
      "        try{",
      "          if(typeof u!=='string' || u.indexOf('blob:')!==0) return;",
      "          protectUntil.set(u, Date.now() + (ms||30000));",
      "        }catch(e){}",
      "      }",
      "      function isProt(u){",
      "        try{",
      "          var t = protectUntil.get(u);",
      "          if(!t) return false;",
      "          if(Date.now()>t){ protectUntil.delete(u); return false; }",
      "          return true;",
      "        }catch(e){ return false; }",
      "      }",
      "      self.__ejsProtectBlobUrl = protect;",
      "      URLObj.revokeObjectURL = function(u){",
      "        try{ u = String(u||''); }catch(e){ u=''; }",
      "        if(isProt(u)){",
      "          warn('[EJS-DIAG] worker: delayed revokeObjectURL for protected blob', u);",
      "          setTimeout(function(){ try{ realRev(u); }catch(e){} }, 35000);",
      "          return;",
      "        }",
      "        return realRev(u);",
      "      };",
      "      URLObj.__ejs_revoke_protect_installed = true;",
      "      log('[EJS-DIAG] worker: installed revokeObjectURL protection');",
      "    }",
      "",
      "    var RealWorker = self.Worker;",
      "    if(RealWorker && !RealWorker.__ejs_nested_fixed){",
      "      self.Worker = function(url, opts){",
      "        try{",
      "          var u = String(url||'');",
      "          if(self.__ejsProtectBlobUrl && u.indexOf('blob:')===0) self.__ejsProtectBlobUrl(u, 30000);",
      "          if(u===''){",
      "            warn('[EJS-DIAG] worker: blocked empty-string Worker, replacing with stub');",
      "            var b = new Blob(['/* ejs worker stub */'], {type:'text/javascript'});",
      "            var bu = (self.URL||self.webkitURL).createObjectURL(b);",
      "            if(self.__ejsProtectBlobUrl) self.__ejsProtectBlobUrl(bu, 30000);",
      "            return new RealWorker(bu, opts);",
      "          }",
      "        }catch(e){}",
      "        return new RealWorker(url, opts);",
      "      };",
      "      self.Worker.__ejs_nested_fixed=true;",
      "      RealWorker.__ejs_nested_fixed=true;",
      "      log('[EJS-DIAG] worker: installed nested Worker fix');",
      "    }",
      "  }catch(e){}",
      "",
      "  try{ importScripts(" + JSON.stringify(emuMainNoQuery) + "); }catch(e){}",
      "})();"
    ].join("\n");
  }

  // -------------------------------------------------
  // 3) Page-level Worker wrapper:
  // - mark blob URLs as protected (prevents early revoke)
  // - guard empty-string worker URLs
  // - for blob: worker URLs, do not try to probe with sync XHR (avoid that warning)
  //   we fix the actual root cause: revocation timing
  // -------------------------------------------------
  function installWorkerFix(emuMainNoQuery) {
    var URLObj = window.URL || window.webkitURL;
    var RealWorker = window.Worker;
    if (!RealWorker || RealWorker.__ejs_worker_fix_installed) return;

    function makeBootstrapUrl() {
      try {
        var bootSrc = makeWorkerBootstrap(emuMainNoQuery);
        var bootBlob = new Blob([bootSrc], { type: "text/javascript" });
        var bootUrl = URLObj.createObjectURL(bootBlob);
        if (window.__ejsProtectBlobUrl) window.__ejsProtectBlobUrl(bootUrl, 30000);
        return bootUrl;
      } catch (e) {
        return null;
      }
    }

    function WrappedWorker(url, opts) {
      var shown = "";
      try { shown = String(url); } catch (e) { shown = "[unstringable]"; }

      if (DIAG) dlog("Worker() called with:", { type: (typeof url), url: shown });

      try {
        // If emulator creates a blob worker, protect it from early revoke
        if (isString(shown) && shown.indexOf("blob:") === 0 && window.__ejsProtectBlobUrl) {
          window.__ejsProtectBlobUrl(shown, 30000);
        }

        // Empty string Worker is always bad
        if (!shown || shown === "undefined" || shown === "null" || shown === "") {
          var bootA = makeBootstrapUrl();
          if (bootA) {
            dwarn("Worker(empty) replaced with bootstrap", { bootstrap: bootA });
            return new RealWorker(bootA, opts);
          }
        }
      } catch (e) {
        derror("Worker wrapper error:", e);
      }

      return new RealWorker(url, opts);
    }

    WrappedWorker.__ejs_worker_fix_installed = true;
    window.Worker = WrappedWorker;
    RealWorker.__ejs_worker_fix_installed = true;

    dlog("Installed Worker() wrapper (revoke-race fix + nested-worker bootstrap)");
  }

  async function start() {
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = "./";
    }
    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);

    safeLog("Path to data is set to " + window.EJS_pathtodata);
    dlog("Normalized EJS_pathtodata:", window.EJS_pathtodata);

    assertRequiredGlobals();

    var emuMainNoQuery = window.EJS_pathtodata + "emulator.js";

    // Install fixes BEFORE emulator.js loads and BEFORE start button triggers workers
    installCreateObjectUrlFix();
    installRevokeProtection();
    installWorkerFix(emuMainNoQuery);

    // Emscripten Module hints (must be set before emulator.js)
    try {
      window.Module = window.Module || {};

      window.Module.locateFile = function (path, prefix) {
        return window.EJS_pathtodata + path;
      };

      window.Module.mainScriptUrlOrBlob = emuMainNoQuery;

      // Hard discourage pthreads and pools
      window.Module.PTHREAD_POOL_SIZE = 0;
      window.Module.pthreadPoolSize = 0;

      window.Module.pthreadMainRuntimeThreadScript = emuMainNoQuery;
      window.Module.pthreadWorkerUrl = emuMainNoQuery;
      window.Module.pthreadWorkerFile = emuMainNoQuery;

      window.Module.print = function () { safeLog.apply(null, arguments); };
      window.Module.printErr = function () { safeError.apply(null, arguments); };

      dlog("Module hints set. mainScriptUrlOrBlob:", window.Module.mainScriptUrlOrBlob);
    } catch (e) {
      derror("Failed to configure Module hints:", e);
    }

    // Cache bust to avoid stale emulator.js
    var emuUrl = emuMainNoQuery + "?v=0.4.23&cb=" + Date.now();

    try {
      dlog("Loading emulator.js:", emuUrl);
      await loadScript(emuUrl);
      dlog("Loaded emulator.js OK");
    } catch (e) {
      safeError("Failed to load emulator.js:", emuUrl, e);
      throw new Error("emulator.js failed to load: " + emuUrl);
    }

    // Wait for constructor
    var ctor = null;
    for (var i = 0; i < 160; i++) {
      ctor = pickCtor();
      if (typeof ctor === "function") break;
      await new Promise(function (r) { setTimeout(r, 25); });
    }

    if (typeof ctor !== "function") {
      safeError("EJS constructor missing after emulator.js load. URL:", emuUrl);
      safeError("typeof window.EJS:", typeof window.EJS);
      safeError("typeof window.EmulatorJS:", typeof window.EmulatorJS);
      safeError("typeof window.Emulator:", typeof window.Emulator);
      throw new TypeError("EJS is not a constructor (missing)");
    }

    dlog("Picked constructor:", ctor && ctor.name ? ctor.name : "(anonymous)");

    var cfg = buildCfg();
    if (cfg && cfg.biosUrl) cfg.biosUrl = absolutizeMaybe(cfg.biosUrl);

    // Force off again
    cfg.threads = false;
    cfg.pthreads = false;
    cfg.threading = false;

    dlog("Final cfg:", cfg);

    var inst = new ctor(window.EJS_player, cfg);
    window.EJS_emulator = inst;

    if (defined(window.EJS_onGameStart) && inst && typeof inst.on === "function") {
      inst.on("start-game", window.EJS_onGameStart);
    }

    dlog("Emulator instance created OK");
  }

  start().catch(function (e) {
    safeError("loader.js fatal error:", e);
    derror("loader.js fatal error stack:", e && e.stack ? e.stack : e);
  });
})();