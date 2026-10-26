/* ==================================================================
 * 深度接入（file:// 页面 ↔ 本地桥接服务）
 *
 * 为什么需要它：浏览器（哪怕是 file://）只能拿到 UVC 的彩色流，拿不到
 * USB 深度设备。所以由 tools/orbbec/openni-bridge.py 用 OpenNI2 读深度，
 * 再通过 WebSocket 推过来。本模块负责收下、降采样成引擎用的小网格。
 *
 * 降采样为什么取"每格最近距离"而不是平均：
 *   人是挡在墙前面的，只有取最近值，人才不会被后面的墙稀释掉。
 *   平均会让"人 + 墙"混成一个中间距离，人就消失了。
 *
 * 桥接没跑时本模块完全不碍事：available() 一直是 false，
 * 引擎自动退回原来的纯彩色画面分析。
 *
 * 用法：
 *   const link = DepthLink.createLink({ width: 96, height: 72 });
 *   link.connect();
 *   if (link.available()) { const g = link.grid(); ... }   // g[i] 单位 mm，0 = 没数据
 * ================================================================== */

(function () {
  "use strict";

  var DEFAULT_URL = "ws://127.0.0.1:8765";

  function createLink(opts) {
    opts = opts || {};
    var url = opts.url || DEFAULT_URL;
    var gw = opts.width || 96;
    var gh = opts.height || 72;
    var cells = gw * gh;
    var autoReconnect = opts.autoReconnect !== false;

    var ws = null;
    var retryTimer = null;
    var closedByUser = false;
    var status = "idle";              // idle | connecting | open | closed | error
    var info = { device: "", serial: "", width: 0, height: 0, note: "",
                 registered: false };

    var grid = new Float32Array(cells);   // 降采样后的深度，单位 mm
    var valid = 0;
    var minMM = 0, maxMM = 0;
    var srcW = 0, srcH = 0;
    var frameIndex = 0;
    var lastAt = 0;                       // performance.now()
    var fps = 0, frames = 0, tMark = 0;

    var SAMPLE_MAX = 81;                  // 采样窗口上限（半径 4 格）
    var sampleBuf = new Float32Array(SAMPLE_MAX);   // 复用，避免每帧分配

    var listeners = [];

    // 每个源像素落到哪个格子：预先算好，避免每帧重复除
    var mapX = null, mapY = null;

    function setStatus(s, detail) {
      if (status === s) return;
      status = s;
      listeners.forEach(function (cb) {
        try { cb(status, detail || ""); } catch (e) { /* 别让回调拖垮接收循环 */ }
      });
    }

    function buildMap(w, h) {
      if (mapX && srcW === w && srcH === h) return;
      srcW = w; srcH = h;
      mapX = new Int32Array(w);
      mapY = new Int32Array(h);
      for (var x = 0; x < w; x++) mapX[x] = Math.min(gw - 1, (x * gw / w) | 0);
      for (var y = 0; y < h; y++) mapY[y] = Math.min(gh - 1, (y * gh / h) | 0);
    }

    // 640x480 → 96x72：每格取最近的非零深度
    function downsample(depth, w, h) {
      buildMap(w, h);
      grid.fill(Infinity);
      var step = (w * h > 200000) ? 2 : 1;     // 大图隔点采样，省 CPU
      var got = 0;
      for (var y = 0; y < h; y += step) {
        var row = y * w;
        var gy = mapY[y] * gw;
        for (var x = 0; x < w; x += step) {
          var v = depth[row + x];
          if (!v) continue;
          var gi = gy + mapX[x];
          if (v < grid[gi]) grid[gi] = v;
          got++;
        }
      }
      // Infinity 换成 0（表示这一格没有深度数据）
      var n = 0, mn = 0, mx = 0;
      for (var i = 0; i < cells; i++) {
        var g = grid[i];
        if (g === Infinity) { grid[i] = 0; continue; }
        n++;
        if (!mn || g < mn) mn = g;
        if (g > mx) mx = g;
      }
      valid = n;
      minMM = mn; maxMM = mx;
      return got;
    }

    /* 在归一化图像坐标 (xNorm, yNorm) 处取一个"可信"的深度值（毫米）。
     * 返回 0 = 这一处没有可用深度。
     *
     * ⚠️ 只有 D2C 对齐过的深度（`registered()` 为真）才可以直接按归一化
     *    (x,y) 采样。没对齐时深度在自己的镜头坐标系里，视场角、内参、基线
     *    都和彩色画面不同，同一个 (x,y) 指的不是同一个物理点。
     *
     * 为什么不能直接读一格：
     *   网格 96×72，一格 ≈ 6.7×6.7 源像素，单格吃噪声；
     *   更麻烦的是细肢体——手臂只占一格宽时，相邻格子全是它背后的墙。
     *   直接取中位数会把墙算进来，手就"退到墙上"了。
     *
     * 做法（先贴人、再拒背景）：
     *   ① 窗口内取所有非零格 → 升序排序
     *   ② 25 分位当作"人"的深度（网格本身是"每格取最近"，近端就是人）
     *   ③ 只保留 [p25, p25×1.25] 内的样本（挡掉背后的墙和个别近端噪点）
     *   ④ 取这批样本的均值
     * 半径默认 2 格（≈33×33 源像素）。
     */
    function sampleMM(xNorm, yNorm, radius) {
      if (!(xNorm >= -0.2 && xNorm <= 1.2 && yNorm >= -0.2 && yNorm <= 1.2)) return 0;
      var r = (radius === undefined || radius === null) ? 2 : (radius | 0);
      if (r < 0) r = 0;
      if (r > 4) r = 4;
      var cx = Math.floor(xNorm * gw);
      var cy = Math.floor(yNorm * gh);
      if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) return 0;
      var x0 = cx - r < 0 ? 0 : cx - r;
      var x1 = cx + r > gw - 1 ? gw - 1 : cx + r;
      var y0 = cy - r < 0 ? 0 : cy - r;
      var y1 = cy + r > gh - 1 ? gh - 1 : cy + r;
      var n = 0;
      for (var y = y0; y <= y1; y++) {
        var row = y * gw;
        for (var x = x0; x <= x1; x++) {
          var v = grid[row + x];
          if (v > 0 && n < SAMPLE_MAX) sampleBuf[n++] = v;
        }
      }
      if (!n) return 0;
      var arr = sampleBuf.subarray(0, n);
      arr.sort();                                  // TypedArray.sort = 数值升序
      var near = arr[(n * 0.25) | 0];
      if (!(near > 0)) return 0;
      var hi = near * 1.25;
      var sum = 0, cnt = 0;
      for (var i = 0; i < n; i++) {
        var q = arr[i];
        if (q >= near && q <= hi) { sum += q; cnt++; }
      }
      return cnt ? (sum / cnt) : near;
    }

    function handleBinary(buf) {
      if (buf.byteLength < 24) return;
      var dv = new DataView(buf);
      var w = dv.getUint32(0, true);
      var h = dv.getUint32(4, true);
      var idx = dv.getUint32(8, true);
      var v = dv.getUint32(12, true);
      var mn = dv.getUint32(16, true);
      var mx = dv.getUint32(20, true);
      if (buf.byteLength < 24 + w * h * 2) return;
      var depth = new Uint16Array(buf, 24, w * h);
      downsample(depth, w, h);
      frameIndex = idx;
      void v; void mn; void mx;
      lastAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
      frames++;
      var now = lastAt;
      if (!tMark) tMark = now;
      if (now - tMark >= 500) {
        fps = Math.round(frames * 1000 / (now - tMark));
        frames = 0; tMark = now;
      }
    }

    function connect() {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      closedByUser = false;
      if (typeof WebSocket === "undefined") { setStatus("error", "浏览器不支持 WebSocket"); return; }
      setStatus("connecting", url);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        setStatus("error", String(e && e.message || e));
        scheduleRetry();
        return;
      }
      ws.binaryType = "arraybuffer";

      ws.onopen = function () { setStatus("open", ""); };

      ws.onmessage = function (ev) {
        if (typeof ev.data === "string") {
          try {
            var m = JSON.parse(ev.data);
            if (m.type === "hello") {
              info.device = m.device || "";
              info.serial = m.serial || "";
              info.width = m.width || 0;
              info.height = m.height || 0;
              info.note = m.note || "";
              /* ★ 深度有没有做过 D2C 对齐（对齐到彩色相机坐标系）。
               * 只有对齐过的深度，才能拿 MediaPipe 关键点的归一化 (x,y)
               * 直接来采样；没对齐时两路视场角/内参/基线都不同，采到的是
               * **别的物理位置**的深度（见 openni-bridge.py 文件头）。
               * 老版本桥不发这个字段 ⇒ 默认 false ⇒ 上层不给 z，安全。 */
              info.registered = (m.registered === true);
            } else if (m.type === "reopen") {
              info.note = "设备重开：" + (m.reason || "");
            }
          } catch (e) { /* ignore */ }
          return;
        }
        if (ev.data && ev.data.byteLength) handleBinary(ev.data);
      };

      ws.onclose = function () {
        ws = null;
        if (closedByUser) { setStatus("closed", ""); return; }
        setStatus("closed", "桥接服务没在跑");
        scheduleRetry();
      };

      ws.onerror = function () { /* onclose 会接着触发 */ };
    }

    function scheduleRetry() {
      if (!autoReconnect || closedByUser || retryTimer) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        connect();
      }, 3000);
    }

    function close() {
      closedByUser = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
      setStatus("closed", "");
    }

    function available() {
      // 3 秒内有新帧才算可用：桥接崩了但 socket 还没断开时也不会误判
      if (status !== "open") return false;
      var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      return lastAt > 0 && (now - lastAt) < 3000;
    }

    return {
      connect: connect,
      close: close,
      available: available,
      grid: function () { return grid; },
      /* 这一路深度是否已对齐到彩色相机坐标系（D2C）。见 hello 处注释。 */
      registered: function () { return !!info.registered; },
      /* 在归一化图像坐标处取可信深度（毫米），0 = 取不到。 */
      sampleMM: sampleMM,
      stats: function () {
        return {
          status: status, fps: fps, valid: valid, cells: cells,
          validRatio: cells ? valid / cells : 0,
          minMM: minMM, maxMM: maxMM, frameIndex: frameIndex,
          device: info.device, serial: info.serial,
          srcW: srcW, srcH: srcH, note: info.note,
          registered: !!info.registered
        };
      },
      onStatus: function (cb) { if (typeof cb === "function") listeners.push(cb); },
      url: url,
      width: gw,
      height: gh
    };
  }

  window.DepthLink = { createLink: createLink, DEFAULT_URL: DEFAULT_URL };
})();
