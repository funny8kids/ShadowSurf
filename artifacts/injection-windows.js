(function () {
  try {
    var C = {"seed":3647934341,"ua":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Safari/537.36","appVersion":"5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Safari/537.36","platform":"Win32","vendor":"Google Inc.","cores":4,"memory":8,"languages":["en-US","en"],"tz":"America/Los_Angeles","locale":"en-US","scr":{"w":1920,"h":1080,"aw":1920,"ah":1040,"depth":24,"dpr":1},"geo":{"lat":37.775641,"lon":-122.419783,"acc":31},"glVendor":"Google Inc. (NVIDIA)","glRenderer":"ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)","canvasNoise":true,"audioNoise":true,"webrtc":"proxy","rectNoise":true,"fonts":["Arial","Arial Black","Bahnschrift","Calibri","Calibri Light","Cambria","Cambria Math","Candara","Comic Sans MS","Consolas","Constantia","Corbel","Courier New","Ebrima","Franklin Gothic Medium","Gabriola","Gadugi","Georgia","Impact","Ink Free","Javanese Text","Leelawadee UI","Lucida Console","Lucida Sans Unicode","Malgun Gothic","Marlett","Microsoft Himalaya","Microsoft JhengHei","Microsoft New Tai Lue","Microsoft PhagsPa","Microsoft Sans Serif","Microsoft Tai Le","Microsoft YaHei","Microsoft Yi Baiti","MingLiU-ExtB","Mongolian Baiti","MS Gothic","MV Boli","Myanmar Text","Nirmala UI","Palatino Linotype","Segoe Fluent Icons","Segoe MDL2 Assets","Segoe Print","Segoe Script","Segoe UI","Segoe UI Emoji","Segoe UI Historic","Segoe UI Symbol","SimSun","Sitka","Sylfaen","Symbol","Tahoma","Times New Roman","Trebuchet MS","Verdana","Webdings","Wingdings","Yu Gothic"],"webgpu":true,"os":"windows"};
    var S = C.seed | 0;

    function h32(a, b, c, d) {
      var h = (S ^ (a | 0) ^ (b | 0) ^ (c | 0) ^ (d | 0)) | 0;
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^ (h >>> 16)) >>> 0;
    }
    function defGet(o, p, fn) {
      try {
        var d = Object.getOwnPropertyDescriptor(o, p);
        Object.defineProperty(o, p, {
          configurable: d ? d.configurable !== false : true,
          enumerable: d ? d.enumerable : true,
          get: fn
        });
      } catch (e) {}
    }
    function defVal(o, p, v) { defGet(o, p, function () { return v; }); }

    var _masked = [];
    var _fakeSrc = function (nm) { return "function " + nm + "() { [native code] }"; };
    var _noProto = function (fn) {
      try { return { f() { return fn.apply(this, arguments); } }.f; } catch (e) { return fn; }
    };
    var _maskOne = function (fn, nm, len) {
      if (typeof fn !== "function") { return fn; }
      try { Object.defineProperty(fn, "name", { value: nm, configurable: true }); } catch (e) {}
      try { if (typeof len === "number") { Object.defineProperty(fn, "length", { value: len, configurable: true }); } } catch (e) {}
      _masked.push(fn);
      return fn;
    };

    try {
      var NP = Navigator.prototype;
      defVal(NP, 'userAgent', C.ua);
      defVal(NP, 'appVersion', C.appVersion);
      defVal(NP, 'platform', C.platform);
      defVal(NP, 'vendor', C.vendor);
      defVal(NP, 'hardwareConcurrency', C.cores);
      defVal(NP, 'deviceMemory', C.memory);
      defVal(NP, 'language', C.languages[0]);
      defGet(NP, 'languages', function () { return C.languages.slice(); });
      defVal(NP, 'webdriver', false);
      defVal(NP, 'pdfViewerEnabled', true);
    } catch (e) {}

    try {
      var SP = Screen.prototype;
      defVal(SP, 'width', C.scr.w);
      defVal(SP, 'height', C.scr.h);
      defVal(SP, 'availWidth', C.scr.aw);
      defVal(SP, 'availHeight', C.scr.ah);
      defVal(SP, 'colorDepth', C.scr.depth);
      defVal(SP, 'pixelDepth', C.scr.depth);
    } catch (e) {}

    try {
      defGet(window, 'devicePixelRatio', function () { return C.scr.dpr; });
    } catch (e) {}

    try {
      if (C.tz) {
      var _DTF = Intl.DateTimeFormat;
      var _lang = (C.languages && C.languages.length) ? C.languages[0] : 'en-US';
      var _Patched = function (locales, options) {
        var o = {};
        if (options) { for (var k in options) { o[k] = options[k]; } }
        // 站点显式要 UTC 时要放行，只有缺省才补默认时区
        if (!o.timeZone) { o.timeZone = C.tz; }
        // 缺省 locale 也要跟着走：navigator.languages 说 en-US，
        // Intl 默认却还是宿主机的 zh-CN，是个一眼可见的矛盾
        if (locales === undefined || locales === null) { locales = _lang; }
        return new _DTF(locales, o);
      };
      _Patched.prototype = _DTF.prototype;
      _Patched.supportedLocalesOf = _DTF.supportedLocalesOf;
      try {
        Object.defineProperty(_DTF.prototype, "constructor", { value: _Patched, configurable: true, writable: true });
      } catch (e) {}
      try {
        Object.defineProperty(_Patched, "name", { value: "DateTimeFormat", configurable: true });
        Object.defineProperty(_Patched, "length", { value: 0, configurable: true });
      } catch (e) {}
      Intl.DateTimeFormat = _Patched;

      // 其余 Intl 构造器同理，缺省 locale 一并接管
      var _IN = ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'PluralRules', 'ListFormat', 'DisplayNames', 'Segmenter'];
      for (var ni = 0; ni < _IN.length; ni++) {
        (function (nm) {
          var Orig = Intl[nm];
          if (typeof Orig !== "function") { return; }
          var W = function (locales, options) {
            if (locales === undefined || locales === null) { locales = _lang; }
            return new Orig(locales, options);
          };
          W.prototype = Orig.prototype;
          if (Orig.supportedLocalesOf) { W.supportedLocalesOf = Orig.supportedLocalesOf; }
          try { Object.defineProperty(Orig.prototype, "constructor", { value: W, configurable: true, writable: true }); } catch (e) {}
          try {
            Object.defineProperty(W, "name", { value: nm, configurable: true });
            Object.defineProperty(W, "length", { value: 0, configurable: true });
          } catch (e) {}
          Intl[nm] = W;
        })(_IN[ni]);
      }

      var _parts = new _DTF("en-US", {
        timeZone: C.tz, hour12: false, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      var _nameFmt = new _DTF('en-US', { timeZone: C.tz, timeZoneName: 'long' });
      var _gtzoNative = Date.prototype.getTimezoneOffset;
      var _offT = NaN, _offV = 0;
      var _targetOff = function (d) {
        var t = d.getTime();
        if (t === _offT) { return _offV; }
        var y = 0, mo = 1, dd = 1, hh = 0, mi = 0, ss = 0;
        var arr = _parts.formatToParts(d);
        for (var i = 0; i < arr.length; i++) {
          var tp = arr[i].type, v = parseInt(arr[i].value, 10);
          if (tp === 'year') { y = v; }
          else if (tp === 'month') { mo = v; }
          else if (tp === 'day') { dd = v; }
          else if (tp === 'hour') { hh = v % 24; }
          else if (tp === 'minute') { mi = v; }
          else if (tp === 'second') { ss = v; }
        }
        var asUTC = Date.UTC(y, mo - 1, dd, hh, mi, ss);
        var off = Math.round((t - asUTC) / 60000);
        if (!isFinite(off)) { off = 0; }
        _offT = t; _offV = off;
        return off;
      };
      Date.prototype.getTimezoneOffset = function () {
        try { return _targetOff(this); } catch (e) { return 0; }
      };

      var _shifted = function (d) {
        var t = _targetOff(d), h = 0;
        try { h = _gtzoNative.call(d); } catch (e) {}
        return new Date(d.getTime() + (h - t) * 60000);
      };
      var _GETS = ['getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds'];
      for (var gi = 0; gi < _GETS.length; gi++) {
        (function (nm) {
          var orig = Date.prototype[nm];
          Date.prototype[nm] = function () { return orig.apply(_shifted(this), arguments); };
        })(_GETS[gi]);
      }

      var _p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      var _DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var _zoneName = function (d) {
        try {
          var a = _nameFmt.formatToParts(d);
          for (var i = 0; i < a.length; i++) { if (a[i].type === 'timeZoneName') { return a[i].value; } }
        } catch (e) {}
        return '';
      };
      // 原生 toTimeString 印的是宿主机时区的 GMT 偏移和时区名，必须整个重写
      Date.prototype.toTimeString = function () {
        if (isNaN(this.getTime())) { return "Invalid Date"; }
        var off = -this.getTimezoneOffset();
        var sg = off >= 0 ? '+' : '-';
        var ab = Math.abs(off);
        var zone = 'GMT' + sg + _p2(Math.floor(ab / 60)) + _p2(ab % 60);
        var nm = _zoneName(this);
        return _p2(this.getHours()) + ':' + _p2(this.getMinutes()) + ':' + _p2(this.getSeconds()) + ' ' + zone + (nm ? ' (' + nm + ')' : '');
      };
      Date.prototype.toDateString = function () {
        if (isNaN(this.getTime())) { return "Invalid Date"; }
        return _DOW[this.getDay()] + ' ' + _MON[this.getMonth()] + ' ' + _p2(this.getDate()) + ' ' + this.getFullYear();
      };
      Date.prototype.toString = function () {
        if (isNaN(this.getTime())) { return "Invalid Date"; }
        return this.toDateString() + ' ' + this.toTimeString();
      };

      var _withTz = function (fn) {
        return function (l, o) {
          var q = {};
          if (o) { for (var k in o) { q[k] = o[k]; } }
          q.timeZone = C.tz;
          if (l === undefined || l === null) { l = _lang; }
          return fn.call(this, l, q);
        };
      };
      Date.prototype.toLocaleString = _withTz(Date.prototype.toLocaleString);
      Date.prototype.toLocaleDateString = _withTz(Date.prototype.toLocaleDateString);
      Date.prototype.toLocaleTimeString = _withTz(Date.prototype.toLocaleTimeString);
      }
    } catch (e) {}

    try {
      var _syn = window.speechSynthesis;
      if (_syn && _syn.getVoices && C.languages && C.languages.length) {
        var _want = String(C.languages[0]).toLowerCase().split("-")[0];
        // 宿主机常常只装了本机语言的语音包，过滤后为空。此时退回真实列表
        // 等于自曝，所以按目标系统补几条出厂自带的标准语音。
        var _FAKE = C.os === "macos"
          ? ["Samantha", "Alex", "Fred", "Victoria", "Daniel"]
          : C.os === "linux"
            ? ["English (America)", "English (Great Britain)"]
            : ["Microsoft David - English (United States)", "Microsoft Zira - English (United States)", "Microsoft Mark - English (United States)"];
        var _made = null;
        var _gv = _syn.getVoices;
        _syn.getVoices = function () {
          var all = _gv.call(_syn) || [];
          var out = [];
          for (var i = 0; i < all.length; i++) {
            var lg = String(all[i].lang || "").toLowerCase().replace("_", "-");
            if (lg.split("-")[0] === _want) { out.push(all[i]); }
          }
          if (out.length) { return out; }
          if (!_made) {
            _made = [];
            for (var j = 0; j < _FAKE.length; j++) {
              _made.push({
                name: _FAKE[j], lang: C.languages[0], localService: true,
                default: j === 0, voiceURI: _FAKE[j]
              });
            }
          }
          return _made.slice();
        };
      }
    } catch (e) {}

    try {
      var GP = window.Geolocation && Geolocation.prototype;
      if (GP && C.geo) {
        var _reply = function (cb) {
          if (typeof cb !== "function") { return; }
          var pos = {
            coords: {
              latitude: C.geo.lat, longitude: C.geo.lon, accuracy: C.geo.acc,
              altitude: null, altitudeAccuracy: null, heading: null, speed: null
            },
            timestamp: Date.now()
          };
          setTimeout(function () { cb(pos); }, 0);
        };
        GP.getCurrentPosition = function (ok) { _reply(ok); };
        GP.watchPosition = function (ok) { _reply(ok); return 1; };
      }
    } catch (e) {}

    try {
      var CE = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
      if (CE && C.canvasNoise) {
        var C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
        var _scrub = function (cv) {
          var w = cv.width, h = cv.height;
          if (!w || !h || w * h > 4194304) { return; }
          var ctx = null;
          try { ctx = cv.getContext("2d"); } catch (e) { return; }
          if (!ctx) { return; }
          var img = ctx.getImageData(0, 0, w, h);
          ctx.putImageData(img, 0, 0);
        };
        if (C2D) {
          var _gid = C2D.getImageData;
          C2D.getImageData = function (sx, sy, sw, sh) {
            var img = _gid.call(this, sx, sy, sw, sh);
            try {
              if (!sw || !sh) { return img; }
              var d = img.data;
              for (var i = 0; i < d.length; i += 4) {
                var idx = i >>> 2;
                var px = idx % sw, py = (idx / sw) | 0;
                var k = h32(px, py, sx, sy);
                d[i] = (d[i] & 254) | (k & 1);
                d[i + 1] = (d[i + 1] & 254) | ((k >>> 1) & 1);
                d[i + 2] = (d[i + 2] & 254) | ((k >>> 2) & 1);
              }
            } catch (e) {}
            return img;
          };
        }
        var _tdu = CE.toDataURL;
        CE.toDataURL = function () {
          try { _scrub(this); } catch (e) {}
          return _tdu.apply(this, arguments);
        };
        var _tob = CE.toBlob;
        if (_tob) {
          CE.toBlob = function () {
            try { _scrub(this); } catch (e) {}
            return _tob.apply(this, arguments);
          };
        }
      }
    } catch (e) {}

    try {
      var AN = window.AnalyserNode && AnalyserNode.prototype;
      if (AN && C.audioNoise) {
        var _gff = AN.getFloatFrequencyData;
        AN.getFloatFrequencyData = function (arr) {
          _gff.call(this, arr);
          try {
            for (var i = 0; i < arr.length; i++) {
              var k = h32(i, 31, 7, 13) % 2000;
              arr[i] = arr[i] + (k - 1000) * 1e-10;
            }
          } catch (e) {}
        };
      }
    } catch (e) {}

    try {
      var _patchGL = function (G) {
        if (!G || !G.prototype || !G.prototype.getParameter) { return; }
        var _gp = G.prototype.getParameter;
        G.prototype.getParameter = function (p) {
          if (p === 37445) { return C.glVendor; }
          if (p === 37446) { return C.glRenderer; }
          return _gp.apply(this, arguments);
        };
      };
      _patchGL(window.WebGLRenderingContext);
      _patchGL(window.WebGL2RenderingContext);
    } catch (e) {}

    try {
      var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (RTC && RTC.prototype) {
        if (C.webrtc === 'disabled') {
          var _deny = function () {
            throw new Error('RTCPeerConnection is disabled by policy');
          };
          RTC.prototype.createDataChannel = _deny;
          RTC.prototype.createOffer = _deny;
        } else if (C.webrtc === 'proxy') {
          var _priv = function (ip) {
            if (!ip || /.local$/i.test(ip)) { return true; }
            if (/^10./.test(ip) || /^192.168./.test(ip) || /^169.254./.test(ip) || /^127./.test(ip)) { return true; }
            if (/^172.(1[6-9]|2[0-9]|3[01])./.test(ip)) { return true; }
            if (/^(fc|fd|fe80)/i.test(ip)) { return true; }
            return false;
          };
          var _keep = function (cand) {
            if (!cand || !cand.candidate || cand.candidate.indexOf(' typ host') === -1) { return cand; }
            var m = /([0-9]{1,3}(.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{0,4}){2,}|[^s]+.local)/i.exec(cand.candidate);
            if (m && _priv(m[1])) { return null; }
            return cand;
          };
          var _guard = function (pc) {
            var add = pc.addEventListener;
            pc.addEventListener = _maskOne(_noProto(function (t, fn, o) {
              if (t === 'icecandidate' && typeof fn === 'function') {
                return add.call(this, t, function (e) { var c = _keep(e); if (c) { fn.call(this, c); } }, o);
              }
              return add.apply(this, arguments);
            }), "addEventListener", 2);
            var on = null;
            try {
              Object.defineProperty(pc, 'onicecandidate', {
                configurable: true,
                get: _maskOne(_noProto(function () { return on; }), "get onicecandidate", 0),
                set: _maskOne(_noProto(function (fn) {
                  on = fn;
                  if (typeof fn === "function") {
                    add.call(pc, 'icecandidate', function (e) { var c = _keep(e); if (c) { fn.call(pc, c); } });
                  }
                }), "set onicecandidate", 1)
              });
            } catch (e) {}
          };
          var _PC = function (cfg) { var pc = new RTC(cfg); _guard(pc); return pc; };
          _PC.prototype = RTC.prototype;
          try { Object.setPrototypeOf(_PC, RTC); } catch (e) {}
          try { Object.defineProperty(RTC.prototype, "constructor", { value: _PC, configurable: true, writable: true }); } catch (e) {}
          try {
            Object.defineProperty(_PC, "name", { value: "RTCPeerConnection", configurable: true });
            Object.defineProperty(_PC, "length", { value: 0, configurable: true });
          } catch (e) {}
          window.RTCPeerConnection = _PC;
        }
      }
    } catch (e) {}

    try {
      if (C.audioNoise && window.AudioBuffer) {
        var _AB = AudioBuffer.prototype;
        var _gcd = _AB.getChannelData;
        var _seen = typeof WeakSet === "function" ? new WeakSet() : null;
        _AB.getChannelData = function (ch) {
          var data = _gcd.call(this, ch);
          if (_seen) { if (_seen.has(data)) { return data; } _seen.add(data); }
          for (var i = 0; i < data.length; i += 997) {
            var kk = h32(i, ch, 13, 5) % 2000;
            data[i] += (kk - 1000) / 1e9;
          }
          return data;
        };
      }
    } catch (e) {}

    try {
      if (C.rectNoise) {
        var EP = Element.prototype;
        var _jit = function (v, s) {
          var q = Math.round(v * 100);
          var k = h32(q, s, 11, 7) % 2000;
          return v + (k - 1000) / 100000;
        };
        var _mk = function (r) {
          var x = _jit(r.left, 1), y = _jit(r.top, 2);
          var w = _jit(r.width, 3), h = _jit(r.height, 4);
          try {
            return new DOMRect(x, y, w, h);
          } catch (e) {
            return { x: x, y: y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
          }
        };
        var _gbcr = EP.getBoundingClientRect;
        EP.getBoundingClientRect = function () { return _mk(_gbcr.call(this)); };
        var _gcr = EP.getClientRects;
        EP.getClientRects = function () {
          var src = _gcr.call(this), out = [];
          for (var i = 0; i < src.length; i++) { out.push(_mk(src[i])); }
          out.item = function (i) { return this[i] || null; };
          return out;
        };
      }
    } catch (e) {}

    try {
      if (C.fonts && C.fonts.length && document.fonts && document.fonts.check) {
        var WL = {};
        for (var fi = 0; fi < C.fonts.length; fi++) { WL[C.fonts[fi].toLowerCase()] = 1; }
        var GEN = { 'serif': 1, 'sans-serif': 1, 'monospace': 1, 'cursive': 1, 'fantasy': 1, 'system-ui': 1 };
        var QUOTE = /\x22([^\x22]+)\x22|'([^']+)'/g;
        var _fams = function (s) {
          var out = [], m;
          QUOTE.lastIndex = 0;
          while ((m = QUOTE.exec(s))) { out.push(String(m[1] || m[2]).toLowerCase()); }
          if (!out.length) {
            var parts = String(s).split(/\s+/), cut = -1;
            for (var i = 0; i < parts.length; i++) {
              if (/^[\d.]+(px|pt|em|rem|%)$/.test(parts[i])) { cut = i; break; }
            }
            if (cut >= 0) {
              var rest = parts.slice(cut + 1).join(' ').split(',');
              for (var j = 0; j < rest.length; j++) {
                var name = rest[j].trim().toLowerCase();
                if (name) { out.push(name); }
              }
            }
          }
          return out;
        };
        var _check = document.fonts.check;
        document.fonts.check = function (font) {
          try {
            var list = _fams(String(font));
            for (var i = 0; i < list.length; i++) {
              if (WL[list[i]] || GEN[list[i]]) { return true; }
            }
            if (list.length) { return false; }
          } catch (e) {}
          return _check.apply(document.fonts, arguments);
        };

        if (window.CanvasRenderingContext2D) {
          var _mt = CanvasRenderingContext2D.prototype.measureText;
          var _probe = document.createElement("canvas").getContext("2d");
          var _miss = {};
          var _bare = function (s) { return String(s).replace(/["']/g, "").trim().toLowerCase(); };
          CanvasRenderingContext2D.prototype.measureText = function (text) {
            try {
              var f = this.font || "";
              var m = /([0-9.]+)px\s+(.+)$/.exec(f);
              if (m && _probe) {
                var fams = m[2].split(",");
                // 注意转小写：WL 的键是小写的，这里漏了就会让白名单永远命中不了，
                // 结果是连 Arial 都被判成「不存在」——比不伪装更像机器人
                var first = _bare(fams[0]);
                if (first && !GEN[first]) {
                  var fb = _bare(fams[fams.length - 1]) || "sans-serif";
                  if (fb === first) { fb = "sans-serif"; }
                  if (!WL[first]) {
                    // 不在目标系统的字体表里 → 一律按 fallback 量，假装没有
                    _probe.font = m[1] + "px " + fb;
                    return _mt.call(_probe, text);
                  }
                  // 在表里，但宿主机可能根本没装（macOS 环境的 Helvetica Neue
                  // 跑在 Windows 上）。量出来和 fallback 等宽就说明缺字，
                  // 补一个确定性偏移，让探测方看到「存在且宽度不同」。
                  var miss = _miss[f];
                  if (miss === undefined) {
                    var w1 = _mt.call(this, "mmmmmmmmmmlli").width;
                    _probe.font = m[1] + "px " + fb;
                    var w2 = _mt.call(_probe, "mmmmmmmmmmlli").width;
                    miss = Math.abs(w1 - w2) > 0.1 ? 0 : 1;
                    _miss[f] = miss;
                  }
                  if (miss) {
                    var mt = _mt.call(this, text);
                    _probe.font = m[1] + "px " + fb;
                    var wf = _mt.call(_probe, text).width;
                    var dl = 0.2 + (h32(String(text).length, first.length, 7, 3) % 400) / 1000;
                    try { Object.defineProperty(mt, "width", { value: wf + dl, configurable: true }); } catch (e) {}
                    return mt;
                  }
                }
              }
            } catch (e) {}
            return _mt.apply(this, arguments);
          };
        }
      }
    } catch (e) {}

    try {
      if (!C.webgpu) {
        var removed = false;
        try { removed = delete Navigator.prototype.gpu; } catch (e) {}
        if (!removed) { defVal(Navigator.prototype, 'gpu', undefined); }
      }
    } catch (e) {}

    try {
      // 原生方法 / getter / setter 都没有 prototype，普通函数字面量有。
      // 于是 `"prototype" in fn` 一行就能把整张 hook 清单枚举出来 ——
      // 比 toString 泄漏更彻底，而且这个洞恰恰是「用函数字面量做包装」这个修法自己造的。
      // 方法简写既没有 prototype 又保留 this 绑定，是这里唯一能同时满足两边的形态。
      // _noProto 在脚本顶部声明（geolocation / 音频 / WebRTC 中途就要用）
      // 传进来的可能已经是原生函数；重复登记不改变行为，输出仍是 native 串
      var _maskAt = function (obj, prop, nm, keepProto) {
        try {
          var d = Object.getOwnPropertyDescriptor(obj, prop);
          if (!d) { return; }
          if (typeof d.get === "function" || typeof d.set === "function") {
            // accessor 一律去掉 prototype：原生 getter 从来没有 prototype
            Object.defineProperty(obj, prop, {
              configurable: d.configurable, enumerable: d.enumerable,
              get: typeof d.get === "function" ? _maskOne(_noProto(d.get), "get " + nm, 0) : d.get,
              set: typeof d.set === "function" ? _maskOne(_noProto(d.set), "set " + nm, 1) : d.set
            });
            return;
          }
          if (typeof d.value === "function") {
            // 构造器必须保留 prototype（原生构造器本来就有），普通方法必须去掉
            var f = keepProto ? d.value : _noProto(d.value);
            if (f !== d.value) {
              Object.defineProperty(obj, prop, {
                configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, value: f
              });
            }
            _maskOne(f, nm);
          }
        } catch (e) {}
      };
      var _maskAll = function (obj, names, keepProto) {
        for (var i = 0; i < names.length; i++) { _maskAt(obj, names[i], names[i], keepProto); }
      };

      _maskAll(Navigator.prototype, ["userAgent", "appVersion", "platform", "vendor",
        "hardwareConcurrency", "deviceMemory", "language", "languages", "webdriver",
        "pdfViewerEnabled", "plugins", "mimeTypes", "maxTouchPoints", "gpu"]);
      _maskAll(Screen.prototype, ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"]);
      _maskAll(window, ["devicePixelRatio"]);
      _maskAll(Date.prototype, ["getTimezoneOffset", "toTimeString", "toDateString", "toString",
        "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "getFullYear", "getMonth",
        "getDate", "getDay", "getHours", "getMinutes", "getSeconds"]);
      _maskAll(Element.prototype, ["getBoundingClientRect", "getClientRects"]);
      if (window.AudioBuffer) { _maskAll(AudioBuffer.prototype, ["getChannelData"]); }
      if (window.CanvasRenderingContext2D) {
        _maskAll(CanvasRenderingContext2D.prototype, ["measureText", "getImageData"]);
      }
      if (window.HTMLCanvasElement) { _maskAll(HTMLCanvasElement.prototype, ["toDataURL", "toBlob"]); }
      if (window.WebGLRenderingContext) { _maskAll(WebGLRenderingContext.prototype, ["getParameter"]); }
      if (window.WebGL2RenderingContext) { _maskAll(WebGL2RenderingContext.prototype, ["getParameter"]); }
      if (document.fonts) { _maskAt(document.fonts, "check", "check"); }
      if (window.speechSynthesis) { _maskAt(speechSynthesis, "getVoices", "getVoices"); }
      if (window.Geolocation) { _maskAll(Geolocation.prototype, ["getCurrentPosition", "watchPosition"]); }
      if (window.AnalyserNode) { _maskAll(AnalyserNode.prototype, ["getFloatFrequencyData"]); }
      if (window.RTCPeerConnection) {
        _maskOne(window.RTCPeerConnection, "RTCPeerConnection");
        _maskAll(window.RTCPeerConnection.prototype, ["createDataChannel", "createOffer", "addEventListener"]);
      }
      if (window.Intl) {
        _maskOne(Intl.DateTimeFormat, "DateTimeFormat");
        _maskOne(Intl.NumberFormat, "NumberFormat");
        _maskOne(Intl.Collator, "Collator");
        _maskOne(Intl.RelativeTimeFormat, "RelativeTimeFormat");
        _maskOne(Intl.PluralRules, "PluralRules");
        _maskOne(Intl.ListFormat, "ListFormat");
        _maskOne(Intl.DisplayNames, "DisplayNames");
        _maskOne(Intl.Segmenter, "Segmenter");
      }

      var _fts = Function.prototype.toString;
      var _patched = _maskOne(_noProto(function () {
        for (var i = 0; i < _masked.length; i++) {
          if (_masked[i] === this) { return _fakeSrc(String(this.name || "")); }
        }
        return _fts.call(this);
      }), "toString", 0);
      Function.prototype.toString = _patched;
    } catch (e) {}
  } catch (e) {}
})();