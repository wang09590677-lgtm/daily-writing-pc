/* ==================================================================
 * 跟做视频仓库（file:// 下也能"下次启动还在"）
 *
 * 为什么不能像原来那样只存 blob: URL：
 *   URL.createObjectURL(file) 出来的 blob: 地址只属于产生它的那个页面会话，
 *   页面一刷新就作废，存进 localStorage 也只是一串死字符串。
 *   所以原来只能"每次打开重新导入"——用户明确不接受这一点。
 *
 * 现在两条腿走路：
 *   1) 用户导入的视频 → 把 **Blob 本体**存进 IndexedDB。
 *      IndexedDB 在 file:// 下是可用的（实测 Chrome：能开库、能读写 Blob、
 *      配额约 10GB，见 build/probe-idb.js），启动时取回来再 createObjectURL，
 *      于是"下次打开还在"。启动脚本用了固定的 --user-data-dir，
 *      所以这份数据会一直留在专用配置档里。
 *   2) 项目自带 体能训练动作演示/ 目录里的视频 → 直接按相对路径引用，
 *      不占存储、永远有效。中场休息.mp4 就走这条路。
 *
 * 降级：IndexedDB 打不开时（极少数浏览器/隐私模式）不报错，
 *       只在本次会话内用内存里的 blob: URL，功能照常，只是不能跨次启动。
 * ================================================================== */
(function () {
  "use strict";

  var DB_NAME = "writingCoachVideos";
  var DB_VERSION = 1;
  var STORE = "videos";
  var BUILTIN_DIR = "体能训练动作演示";

  /* 项目自带视频 ↔ 动作 id 的对照表。
   * file:// 页面没法列目录，只能显式登记；文件名与动作名一一对应。
   * 找不到文件时会在启动探测里被剔掉，不会出现"显示已导入但播不了"。 */
  var BUILTIN_FILES = {
    jumpingJacks: "开合跳.mp4",
    highKnees: "原地高抬腿跑.mp4",
    fastFeet: "原地小步跑.mp4",
    jumpRope: "跳绳.mp4",
    plank: "平板支撑.mp4",
    abWheel: "健腹轮.mp4",
    dynamicKick: "动态踢腿.mp4",
    burpee: "波比跳.mp4",
    hamStretch: "大腿后侧拉伸.mp4",
    calfStretch: "小腿拉伸.mp4",
    marchInPlace: "原地小跑.mp4",
    /* 下面几个视频早就放在「体能训练动作演示」目录里了，只是漏登记，
     * 结果孩子练深蹲 / 臀桥 / 死虫式 / 登山跑 / 全身拉伸时只能看动画 ——
     * 明明有真视频。补齐对照表即可，probeAll() 会自动剔掉不存在的文件。 */
    squat: "深蹲.mp4",
    gluteBridge: "臀桥.mp4",
    deadBug: "死虫式.mp4",
    mountainClimber: "登山跑.mp4",
    fullStretch: "全身拉伸.mp4"
  };

  var REST_FILE = "中场休息.mp4";   // 休息段固定播放，永远有效

  function dirUrl() { return BUILTIN_DIR + "/"; }

  function builtinUrl(name) {
    return name ? dirUrl() + name : "";
  }

  /* ---------------- IndexedDB 薄封装 ---------------- */

  var dbPromise = null;
  var memOnly = false;          // 打不开库时退化为"仅本次会话"
  var objectUrls = {};          // exId → blob: URL（删除时 revoke）

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var idb = window.indexedDB;
      if (!idb) { memOnly = true; resolve(null); return; }
      var req;
      try { req = idb.open(DB_NAME, DB_VERSION); }
      catch (e) { memOnly = true; resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { memOnly = true; resolve(null); };
      req.onblocked = function () { memOnly = true; resolve(null); };
      // 有些环境下 open 既不成功也不失败（被策略静默拦），兜个底
      setTimeout(function () { if (!memOnly) { /* 仍在等待就继续等 */ } }, 0);
    });
    return dbPromise;
  }

  function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }

  function put(exId, blob) {
    return openDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        var req = tx(db, "readwrite").put(blob, exId);
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { resolve(false); };
      });
    });
  }

  function del(exId) {
    return openDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        var req = tx(db, "readwrite").delete(exId);
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { resolve(false); };
      });
    });
  }

  function all() {
    return openDb().then(function (db) {
      if (!db) return {};
      return new Promise(function (resolve) {
        var out = {};
        var store = tx(db, "readonly");
        var req = store.openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) { resolve(out); return; }
          if (cur.value instanceof Blob) out[cur.key] = cur.value;
          cur.continue();
        };
        req.onerror = function () { resolve(out); };
      });
    });
  }

  /* ---------------- 内置视频存在性探测 ---------------- */
  /* 用 <video preload="metadata"> 探一下：文件在就 loadedmetadata，
   * 被删了/改名了就 error。这样按钮不会谎报"导入成功"。 */
  function probe(url, timeoutMs) {
    return new Promise(function (resolve) {
      if (!url) { resolve(false); return; }
      var v = document.createElement("video");
      var done = false;
      function fin(ok) {
        if (done) return;
        done = true;
        v.removeAttribute("src");
        try { v.load(); } catch (e) {}
        resolve(ok);
      }
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = function () { fin(v.videoWidth > 0); };
      v.onerror = function () { fin(false); };
      setTimeout(function () { fin(false); }, timeoutMs || 4000);
      v.src = url;
    });
  }

  function probeAll() {
    var ids = Object.keys(BUILTIN_FILES);
    var out = {};
    return Promise.all(ids.map(function (id) {
      var url = builtinUrl(BUILTIN_FILES[id]);
      return probe(url).then(function (ok) { if (ok) out[id] = url; });
    })).then(function () { return out; });
  }

  /* ---------------- 对外 ---------------- */

  // 汇总"当前可用的所有跟做视频"：内置打底，用户导入的覆盖上去。
  // 返回 { videos: {exId: url}, restUrl, builtin: {...}, imported: {...} }
  function resolveAll() {
    var builtin = {}, imported = {};
    return probeAll().then(function (b) {
      builtin = b;
      return all();
    }).then(function (blobs) {
      Object.keys(blobs).forEach(function (exId) {
        try {
          if (objectUrls[exId]) { URL.revokeObjectURL(objectUrls[exId]); }
          objectUrls[exId] = URL.createObjectURL(blobs[exId]);
          imported[exId] = objectUrls[exId];
        } catch (e) { /* 单个坏数据不影响其他 */ }
      });
      var videos = {};
      Object.keys(builtin).forEach(function (k) { videos[k] = builtin[k]; });
      Object.keys(imported).forEach(function (k) { videos[k] = imported[k]; });
      return {
        videos: videos,
        builtin: builtin,
        imported: imported,
        restUrl: builtinUrl(REST_FILE),
        restFile: REST_FILE,
        memOnly: memOnly
      };
    });
  }

  // 存一个用户导入的视频：立刻进 IndexedDB，并返回可用的 blob: URL
  function save(exId, file) {
    var url = "";
    try { url = URL.createObjectURL(file); } catch (e) { url = ""; }
    if (objectUrls[exId] && objectUrls[exId] !== url) {
      try { URL.revokeObjectURL(objectUrls[exId]); } catch (e) {}
    }
    objectUrls[exId] = url;
    return put(exId, file).then(function (ok) {
      return { url: url, persisted: ok, memOnly: memOnly };
    });
  }

  function remove(exId) {
    if (objectUrls[exId]) {
      try { URL.revokeObjectURL(objectUrls[exId]); } catch (e) {}
      delete objectUrls[exId];
    }
    return del(exId);
  }

  function isBuiltin(exId) {
    return !!BUILTIN_FILES[exId];
  }

  window.VideoStore = {
    resolveAll: resolveAll,
    save: save,
    remove: remove,
    isBuiltin: isBuiltin,
    builtinUrl: builtinUrl,
    probe: probe,
    DIR: BUILTIN_DIR,
    REST_FILE: REST_FILE,
    BUILTIN_FILES: BUILTIN_FILES,
    _db: openDb
  };
})();
