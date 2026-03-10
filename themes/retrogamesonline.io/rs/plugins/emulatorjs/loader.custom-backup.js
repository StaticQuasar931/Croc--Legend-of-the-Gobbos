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

  function isLikelyJsMime(type) {
    var t = String(type || "").toLowerCase();
    return (t.indexOf("javascript") !== -1) || (t.indexOf("ecmascript") !== -1) || (t.indexOf("text/plain") !== -1);
  }

  function isEffectivelyEmptyJs(source) {
    if (!isString(source)) return false;
    var s = source.replace(/^\uFEFF/, "");
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    s = s.replace(/(^|[\r\n])\s*\/\/[^\r\n]*/g, "$1");
    s = s.replace(/\s+/g, "");
    return s.length === 0;
  }

  function makeExecutableWorkerStub(importUrl, fallbackUrl, isModuleWorker) {
    var target = isString(importUrl) ? importUrl : "";
    var fallback = isString(fallbackUrl) ? fallbackUrl : "";
    var isModule = !!isModuleWorker;

    if (isModule) {
      return [
        "self.__ejsWorkerBootstrap = 1;",
        "(async function(){",
        "  try {",
        "    if (" + JSON.stringify(target) + ") {",
        "      await import(" + JSON.stringify(target) + ");",
        "      return;",
        "    }",
        "    throw new Error('empty module worker target');",
        "  } catch (e1) {",
        "    try {",
        "      if (" + JSON.stringify(fallback) + ") {",
        "        await import(" + JSON.stringify(fallback) + ");",
        "        return;",
        "      }",
        "      throw e1;",
        "    } catch (e2) {",
        "      setTimeout(function () { throw e2; }, 0);",
        "    }",
        "  }",
        "})();"
      ].join("\n");
    }

    return [
      "self.__ejsWorkerBootstrap = 1;",
      "try {",
      "  if (typeof importScripts === 'function' && " + JSON.stringify(target) + ") {",
      "    importScripts(" + JSON.stringify(target) + ");",
      "  } else {",
      "    throw new Error('empty worker target');",
      "  }",
      "} catch (e1) {",
      "  try {",
      "    if (typeof importScripts === 'function' && " + JSON.stringify(fallback) + ") {",
      "      importScripts(" + JSON.stringify(fallback) + ");",
      "    } else {",
      "      throw e1;",
      "    }",
      "  } catch (e2) {",
      "    setTimeout(function () { throw e2; }, 0);",
      "  }",
      "}"
    ].join("\n");
  }

  function tryTagBlobSourceText(blob, parts, options) {
    try {
      if (!blob) return;
      var type = "";
      if (options && isString(options.type)) type = options.type;
      if (!type && isString(blob.type)) type = blob.type;
      if (!isLikelyJsMime(type)) return;
      if (!parts || typeof parts.length !== "number") return;

      var out = "";
      var td = (typeof TextDecoder !== "undefined") ? new TextDecoder("utf-8") : null;

      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (typeof part === "string") {
          out += part;
        } else if (typeof part === "number" || typeof part === "boolean") {
          out += String(part);
        } else if (typeof ArrayBuffer !== "undefined" && part instanceof ArrayBuffer) {
          if (!td) return;
          out += td.decode(new Uint8Array(part));
        } else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(part)) {
          if (!td) return;
          out += td.decode(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
        } else {
          return;
        }

        if (out.length > 262144) return;
      }

      Object.defineProperty(blob, "__ejs_source_text", {
        configurable: true,
        enumerable: false,
        writable: false,
        value: out
      });
    } catch (e) {}
  }

  function installBlobSourceTagger() {
    if (typeof window.Blob !== "function" || window.Blob.__ejs_blob_wrapped) return;
    var RealBlob = window.Blob;

    function WrappedBlob(parts, options) {
      var actualParts = (typeof parts === "undefined") ? [] : parts;
      var b = new RealBlob(actualParts, options);
      tryTagBlobSourceText(b, actualParts, options || {});
      return b;
    }

    WrappedBlob.prototype = RealBlob.prototype;
    try { Object.setPrototypeOf(WrappedBlob, RealBlob); } catch (e) {}
    WrappedBlob.__ejs_blob_wrapped = true;
    RealBlob.__ejs_blob_wrapped = true;
    window.Blob = WrappedBlob;

    dlog("Installed Blob source tagger for JS worker blob inspection");
  }

  // -------------------------------------------------
  // 1) createObjectURL fix: replace effectively-empty JS workers
  // -------------------------------------------------
  function installCreateObjectUrlFix(emuMainNoQuery) {
    var URLObj = window.URL || window.webkitURL;
    if (!URLObj || !URLObj.createObjectURL || URLObj.__ejs_createObjectURL_fixed) return;

    var real = URLObj.createObjectURL.bind(URLObj);

    URLObj.createObjectURL = function (obj) {
      try {
        var isBlob = (typeof Blob !== "undefined") && (obj instanceof Blob);
        if (isBlob) {
          var blobType = String(obj.type || "");
          var isJS = isLikelyJsMime(blobType);
          var src = "";
          try {
            if (isString(obj.__ejs_source_text)) src = obj.__ejs_source_text;
          } catch (e) {}

          var effectivelyEmpty = (obj.size === 0) || (src && isEffectivelyEmptyJs(src));
          // Some EmulatorJS worker blobs arrive with an empty or odd MIME type in Firefox.
          // If the blob body is empty, treat it as a broken worker script anyway.
          if (effectivelyEmpty && (isJS || !blobType)) {
            if (DIAG) dwarn("Replacing effectively-empty worker blob URL", { type: blobType, size: obj.size });
            var fixedSrc = makeExecutableWorkerStub(emuMainNoQuery, emuMainNoQuery, false);
            var fixed = new Blob([fixedSrc], { type: "text/javascript" });
            return real(fixed);
          }
        }
      } catch (e) {}
      return real(obj);
    };

    URLObj.__ejs_createObjectURL_fixed = true;
    dlog("Installed URL.createObjectURL effective-empty JS worker fix");
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
      "  var EMU_MAIN = " + JSON.stringify(emuMainNoQuery) + ";",
      "  function isString(v){ return typeof v === 'string'; }",
      "  function isLikelyJsMime(t){ t=String(t||'').toLowerCase(); return t.indexOf('javascript')!==-1 || t.indexOf('ecmascript')!==-1 || t.indexOf('text/plain')!==-1; }",
      "  function isEffectivelyEmptyJs(source){",
      "    if(!isString(source)) return false;",
      "    var s = source.replace(/^\\uFEFF/, '');",
      "    s = s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');",
      "    s = s.replace(/(^|[\\r\\n])\\s*\\/\\/[^\\r\\n]*/g, '$1');",
      "    s = s.replace(/\\s+/g, '');",
      "    return s.length === 0;",
      "  }",
      "  function makeStub(target, fallback, asModule){",
      "    target = isString(target) ? target : '';",
      "    fallback = isString(fallback) ? fallback : '';",
      "    var moduleWorker = !!asModule;",
      "    if(moduleWorker){",
      "      return [",
      "        'self.__ejsWorkerBootstrap = 1;',",
      "        '(async function(){',",
      "        '  try {',",
      "        '    if (' + JSON.stringify(target) + ') { await import(' + JSON.stringify(target) + '); return; }',",
      "        '    throw new Error(\'empty module worker target\');',",
      "        '  } catch (e1) {',",
      "        '    try {',",
      "        '      if (' + JSON.stringify(fallback) + ') { await import(' + JSON.stringify(fallback) + '); return; }',",
      "        '      throw e1;',",
      "        '    } catch (e2) {',",
      "        '      setTimeout(function(){ throw e2; }, 0);',",
      "        '    }',",
      "        '  }',",
      "        '})();'",
      "      ].join('\\n');",
      "    }",
      "    return [",
      "      'self.__ejsWorkerBootstrap = 1;',",
      "      'try {',",
      "      '  if (typeof importScripts === \'function\' && ' + JSON.stringify(target) + ') {',",
      "      '    importScripts(' + JSON.stringify(target) + ');',",
      "      '  } else {',",
      "      '    throw new Error(\'empty worker target\');',",
      "      '  }',",
      "      '} catch (e1) {',",
      "      '  try {',",
      "      '    if (typeof importScripts === \'function\' && ' + JSON.stringify(fallback) + ') {',",
      "      '      importScripts(' + JSON.stringify(fallback) + ');',",
      "      '    } else {',",
      "      '      throw e1;',",
      "      '    }',",
      "      '  } catch (e2) {',",
      "      '    setTimeout(function(){ throw e2; }, 0);',",
      "      '  }',",
      "      '}'",
      "    ].join('\\n');",
      "  }",
      "",
      "  try{",
      "    var URLObj = self.URL || self.webkitURL;",
      "    var RealBlob = self.Blob;",
      "",
      "    if(typeof RealBlob === 'function' && !RealBlob.__ejs_blob_wrapped){",
      "      self.Blob = function(parts, options){",
      "        var actualParts = (typeof parts === 'undefined') ? [] : parts;",
      "        var b = new RealBlob(actualParts, options);",
      "        try{",
      "          var type = (options && options.type) ? options.type : b.type;",
      "          if(isLikelyJsMime(type) && actualParts && typeof actualParts.length==='number'){",
      "            var out = '';",
      "            var td = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;",
      "            for(var i=0;i<actualParts.length;i++){",
      "              var p = actualParts[i];",
      "              if(typeof p === 'string'){ out += p; }",
      "              else if(typeof p === 'number' || typeof p === 'boolean'){ out += String(p); }",
      "              else if(typeof ArrayBuffer !== 'undefined' && p instanceof ArrayBuffer){ if(!td){ out=''; break; } out += td.decode(new Uint8Array(p)); }",
      "              else if(typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(p)){ if(!td){ out=''; break; } out += td.decode(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); }",
      "              else { out=''; break; }",
      "              if(out.length > 262144){ out=''; break; }",
      "            }",
      "            if(out){ Object.defineProperty(b, '__ejs_source_text', { value: out, configurable: true, enumerable: false }); }",
      "          }",
      "        }catch(e){}",
      "        return b;",
      "      };",
      "      self.Blob.prototype = RealBlob.prototype;",
      "      try{ Object.setPrototypeOf(self.Blob, RealBlob); }catch(e){}",
      "      self.Blob.__ejs_blob_wrapped = true;",
      "      RealBlob.__ejs_blob_wrapped = true;",
      "    }",
      "",
      "    if(URLObj && URLObj.createObjectURL && !URLObj.__ejs_createObjectURL_fixed){",
      "      var realCOU = URLObj.createObjectURL.bind(URLObj);",
      "      URLObj.createObjectURL = function(obj){",
      "        try{",
      "          var isBlob = (typeof self.Blob!=='undefined') && (obj instanceof self.Blob);",
      "          if(isBlob){",
      "            var blobType = String(obj.type||'');",
      "            var isJS = isLikelyJsMime(blobType);",
      "            var src = '';",
      "            try{ if(isString(obj.__ejs_source_text)) src = obj.__ejs_source_text; }catch(e){ }",
      "            if((obj.size===0 || (src && isEffectivelyEmptyJs(src))) && (isJS || !blobType)){",
      "              return realCOU(new self.Blob([makeStub(EMU_MAIN, EMU_MAIN, false)], {type:'text/javascript'}));",
      "            }",
      "          }",
      "        }catch(e){}",
      "        return realCOU(obj);",
      "      };",
      "      URLObj.__ejs_createObjectURL_fixed = true;",
      "    }",
      "",
      "    if(URLObj && URLObj.revokeObjectURL && !URLObj.__ejs_revoke_protect_installed){",
      "      var realRev = URLObj.revokeObjectURL.bind(URLObj);",
      "      var protectUntil = new Map();",
      "      function protect(u, ms){ try{ if(typeof u==='string' && u.indexOf('blob:')===0) protectUntil.set(u, Date.now() + (ms||30000)); }catch(e){} }",
      "      function isProt(u){ try{ var t=protectUntil.get(u); if(!t) return false; if(Date.now()>t){ protectUntil.delete(u); return false; } return true; }catch(e){ return false; } }",
      "      self.__ejsProtectBlobUrl = protect;",
      "      URLObj.revokeObjectURL = function(u){",
      "        try{ u = String(u||''); }catch(e){ u=''; }",
      "        if(isProt(u)){ setTimeout(function(){ try{ realRev(u); }catch(e){} }, 35000); return; }",
      "        return realRev(u);",
      "      };",
      "      URLObj.__ejs_revoke_protect_installed = true;",
      "    }",
      "",
      "    var RealWorker = self.Worker;",
      "    if(RealWorker && !RealWorker.__ejs_nested_fixed){",
      "      self.Worker = function(url, opts){",
      "        try{",
      "          var u = String(url||'');",
      "          var isModule = !!(opts && opts.type === 'module');",
      "          if(!u || u==='undefined' || u==='null'){",
      "            var stubUrl = (self.URL||self.webkitURL).createObjectURL(new self.Blob([makeStub(EMU_MAIN, EMU_MAIN, false)], {type:'text/javascript'}));",
      "            if(self.__ejsProtectBlobUrl) self.__ejsProtectBlobUrl(stubUrl, 30000);",
      "            return new RealWorker(stubUrl, opts);",
      "          }",
      "          if(!isModule && u.indexOf('blob:')===0){",
      "            if(self.__ejsProtectBlobUrl) self.__ejsProtectBlobUrl(u, 30000);",
      "            var tramp = (self.URL||self.webkitURL).createObjectURL(new self.Blob([makeStub(u, EMU_MAIN, isModule)], {type:'text/javascript'}));",
      "            if(self.__ejsProtectBlobUrl) self.__ejsProtectBlobUrl(tramp, 30000);",
      "            return new RealWorker(tramp, opts);",
      "          }",
      "        }catch(e){}",
      "        return new RealWorker(url, opts);",
      "      };",
      "      self.Worker.__ejs_nested_fixed = true;",
      "      RealWorker.__ejs_nested_fixed = true;",
      "    }",
      "  }catch(e){}",
      "",
      "  try{ if(typeof importScripts === 'function') importScripts(EMU_MAIN); }catch(e){ setTimeout(function(){ throw e; }, 0); }",
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

    function makeImportWorkerUrl(targetUrl, isModuleWorker) {
      try {
        var src = makeExecutableWorkerStub(targetUrl, emuMainNoQuery, !!isModuleWorker);
        var blob = new Blob([src], { type: "text/javascript" });
        var url = URLObj.createObjectURL(blob);
        if (window.__ejsProtectBlobUrl) window.__ejsProtectBlobUrl(url, 30000);
        return url;
      } catch (e) {
        return null;
      }
    }

    function WrappedWorker(url, opts) {
      var shown = "";
      try { shown = String(url); } catch (e) { shown = "[unstringable]"; }

      if (DIAG) dlog("Worker() called with:", { type: (typeof url), url: shown });

      try {
        var isModule = !!(opts && opts.type === "module");

        if (isString(shown) && shown.indexOf("blob:") === 0 && window.__ejsProtectBlobUrl) {
          window.__ejsProtectBlobUrl(shown, 30000);
        }

        if (!shown || shown === "undefined" || shown === "null" || shown === "") {
          var bootA = makeBootstrapUrl();
          if (bootA) {
            dwarn("Worker(empty) replaced with bootstrap", { bootstrap: bootA });
            return new RealWorker(bootA, opts);
          }
        }

        if (!isModule && isString(shown) && shown.indexOf("blob:") === 0) {
          var wrapped = makeImportWorkerUrl(shown, isModule);
          if (wrapped) {
            return new RealWorker(wrapped, opts);
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

    dlog("Installed Worker() wrapper (revoke-race + executable bootstrap + nested-worker safety)");
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
    installBlobSourceTagger();
    installCreateObjectUrlFix(emuMainNoQuery);
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


