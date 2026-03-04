(function () {
  "use strict";

  // =================================================
  // EmulatorJS loader.js (page + nested-worker safe fix)
  // Path: /themes/retrogamesonline.io/rs/plugins/emulatorjs/loader.js
  //
  // Goal:
  // - Fix Firefox "Attempting to create a Worker from an empty source"
  // - The warning is typically triggered by a nested Worker created inside the main emulator Worker.
  // - We patch BOTH the page context and the worker context.
  //
  // What this does:
  // 1) Normalizes EJS_pathtodata to an absolute URL with trailing slash
  // 2) Sets Module hints before emulator.js loads
  // 3) Installs:
  //    - URL.createObjectURL: replace 0-byte JS blobs with a non-empty stub
  //    - Worker: if given a blob: URL that is empty, replace with a bootstrap Worker
  //             that installs the same fixes inside the Worker, then importScripts(emulator.js)
  //
  // IMPORTANT:
  // - This does NOT “enable threads”. Threads stay disabled.
  // - This targets only “empty JS worker scripts” so normal workers remain untouched.
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
  // Page-level createObjectURL fix:
  // If a JS blob is size 0, replace it with a non-empty stub.
  // This protects both page workers and any “blank worker” blobs.
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
  // Worker bootstrap that also patches INSIDE the worker,
  // then importScripts(emulator.js).
  // This is the part that fixes your “still happens after start” issue.
  // -------------------------------------------------
  function makeWorkerBootstrap(emuMainNoQuery) {
    // Keep this string simple and standalone.
    // It runs in Worker global scope.
    return [
      "(function(){",
      "  try{",
      "    var DIAG=true;",
      "    function log(){try{if(DIAG) self.console && self.console.log && self.console.log.apply(self.console, arguments);}catch(e){}}",
      "    function warn(){try{if(DIAG) self.console && self.console.warn && self.console.warn.apply(self.console, arguments);}catch(e){}}",

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

      "    var RealWorker = self.Worker;",
      "    if(RealWorker && !RealWorker.__ejs_nested_fixed){",
      "      self.Worker = function(url, opts){",
      "        try{",
      "          var u = String(url||'');",
      "          if(u===''){",
      "            warn('[EJS-DIAG] worker: blocked empty-string Worker, replacing with stub');",
      "            var b = new Blob(['/* ejs worker stub */'], {type:'text/javascript'});",
      "            var bu = (self.URL||self.webkitURL).createObjectURL(b);",
      "            return new RealWorker(bu, opts);",
      "          }",
      "        }catch(e){}",
      "        return new RealWorker(url, opts);",
      "      };",
      "      self.Worker.__ejs_nested_fixed=true;",
      "      RealWorker.__ejs_nested_fixed=true;",
      "      log('[EJS-DIAG] worker: installed nested Worker fix');",
      "    }",
      "  }catch(e){}", // do not hard-fail worker bootstrap

      "  try{ importScripts(" + JSON.stringify(emuMainNoQuery) + "); }catch(e){}",
      "})();"
    ].join("\n");
  }

  // -------------------------------------------------
  // Page-level Worker wrapper:
  // If Worker gets blob: or empty string, ensure it is not empty.
  // If blob: is empty, replace with bootstrap that patches inside worker.
  // -------------------------------------------------
  function installWorkerFix(emuMainNoQuery) {
    var URLObj = window.URL || window.webkitURL;
    var RealWorker = window.Worker;
    if (!RealWorker || RealWorker.__ejs_worker_fix_installed) return;

    function stripForEmptyCheck(src) {
      try {
        if (!isString(src)) return "";
        src = src.replace(/^\uFEFF/, "");
        src = src.replace(/\/\*[\s\S]*?\*\//g, "");
        src = src.replace(/\/\/[^\n\r]*/g, "");
        src = src.replace(/[\s;]+/g, "");
        return src;
      } catch (e) {
        return "";
      }
    }

    function syncGetText(url) {
      var out = { ok: false, status: 0, text: "" };
      try {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, false);
        xhr.send(null);
        out.status = xhr.status || 0;
        out.ok = (out.status >= 200 && out.status < 300) || out.status === 0;
        out.text = xhr.responseText || "";
        return out;
      } catch (e) {
        return out;
      }
    }

    function makeBootstrapUrl() {
      try {
        var bootSrc = makeWorkerBootstrap(emuMainNoQuery);
        var bootBlob = new Blob([bootSrc], { type: "text/javascript" });
        return URLObj.createObjectURL(bootBlob);
      } catch (e) {
        return null;
      }
    }

    function WrappedWorker(url, opts) {
      var shown = "";
      try { shown = String(url); } catch (e) { shown = "[unstringable]"; }

      if (DIAG) dlog("Worker() called with:", { type: (typeof url), url: shown });

      try {
        // Empty string Worker is always bad
        if (!shown || shown === "undefined" || shown === "null" || shown === "") {
          var bootUrlA = makeBootstrapUrl();
          if (bootUrlA) {
            dwarn("Worker(empty) replaced with bootstrap");
            return new RealWorker(bootUrlA, opts);
          }
        }

        // blob: worker source probe
        if (isString(shown) && shown.indexOf("blob:") === 0) {
          var probe = syncGetText(shown);
          var trimmed = stripForEmptyCheck(probe.text);
          var isEffectivelyEmpty = !trimmed || trimmed.length === 0;

          if (DIAG) {
            dlog("Worker(blob) probe:", {
              status: probe.status,
              bytes: (probe.text ? probe.text.length : 0),
              decidedEmpty: isEffectivelyEmpty
            });
          }

          if (isEffectivelyEmpty) {
            var bootUrlB = makeBootstrapUrl();
            if (bootUrlB) {
              dwarn("Worker(blob/empty) replaced with bootstrap", { original: shown, bootstrap: bootUrlB });
              return new RealWorker(bootUrlB, opts);
            }
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

    dlog("Installed Worker() wrapper (page + nested-worker fix)");
  }

  async function start() {
    // Normalize EJS_pathtodata
    if (!defined(window.EJS_pathtodata) || !isString(window.EJS_pathtodata) || !window.EJS_pathtodata.length) {
      window.EJS_pathtodata = "./";
    }
    window.EJS_pathtodata = normalizeBasePath(window.EJS_pathtodata);

    safeLog("Path to data is set to " + window.EJS_pathtodata);
    dlog("Normalized EJS_pathtodata:", window.EJS_pathtodata);

    assertRequiredGlobals();

    // Base emulator script URL (no query)
    var emuMainNoQuery = window.EJS_pathtodata + "emulator.js";

    // Install fixes before emulator.js loads and before start button triggers workers
    installCreateObjectUrlFix();
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

    // Load emulator.js with cache bust to avoid stale files
    var emuUrl = emuMainNoQuery + "?v=0.4.23&cb=" + Date.now();

    try {
      dlog("Loading emulator.js:", emuUrl);
      await loadScript(emuUrl);
      dlog("Loaded emulator.js OK");
    } catch (e) {
      safeError("Failed to load emulator.js:", emuUrl, e);
      throw new Error("emulator.js failed to load: " + emuUrl);
    }

    // Wait for constructor to appear
    var ctor = null;
    for (var i = 0; i < 140; i++) {
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

    // Force these off again in final cfg
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