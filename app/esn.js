/* esn.js : エコーステートネットワーク（リザバーコンピューティング）の部品。
 * 画面（index.html に同じ中身を埋め込み）・MCP サーバー・試験が同じ物を使う。
 * 依存なし。ブラウザでは globalThis.ESN、Node では module.exports。
 * 入力 4（大きさ＋3 軸）・内部 100・疎な結合・スペクトル半径 0.9・漏れ率あり・乱数の種は固定。
 * 学習は出力の重みだけをリッジ回帰（コレスキー分解で自前）で解く。 */
(function (root) {
  'use strict';

  var CFG = {
    rate: 50,        // Hz（入力を間引く先）
    n: 100,          // 内部の数
    nIn: 4,          // 入力の数（大きさ＋3 軸）
    density: 0.1,    // 結合の疎さ
    rho: 0.9,        // スペクトル半径
    leak: 0.3,       // 漏れ率
    inScale: 0.9,    // 入力の強さ
    biasScale: 0.1,
    seed: 20261109,
    ridge: 0.5,      // リッジ回帰の λ（特徴量の二乗和に対する値）
    augCopies: 4,    // 学習で雑音を足して重ねる回数（0 なら元の 3 回分だけ）
    augNoise: 0.4,   // 足す雑音の大きさ（m/s^2）
    negSeconds: 12,  // 「動かない時は 0」の見本を雑音から作って足す秒数（0 なら足さない）
    outSmooth: 0.4,  // 数える前の出力をならす係数（1 ならならさない）
    washout: 25,     // 学習で捨てる最初の標本数（0.5 秒）
    gravTau: 5.0,    // 重力の平均を引くための時定数（秒）
    inputDiv: 3.0,   // 入力をこの値で割って 1 前後にそろえる（m/s^2）
    hi: 0.55, lo: 0.3,  // 数えるしきい値（ヒステリシス）
    minGap: 1.0      // この秒数より短い間隔は数えない
  };

  // ---- 乱数（mulberry32）と正規乱数 ----
  function rng(seed) {
    var a = seed >>> 0;
    var f = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.gauss = function () {
      var u = 0, v = 0;
      while (u === 0) u = f();
      v = f();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return f;
  }

  // ---- リザバーの組み立て（種が同じなら同じ物ができる）----
  function spectralRadius(W, n) {
    // 絶対値最大の固有値の大きさ。ベクトルを何度も掛けて、増え方の平均（対数）から見積もる。
    var rr = rng(7), v = new Float64Array(n), w = new Float64Array(n), i, k, j, s = 0, cnt = 0;
    for (i = 0; i < n; i++) v[i] = rr() - 0.5;
    for (k = 0; k < 600; k++) {
      for (i = 0; i < n; i++) {
        var acc = 0, row = W[i];
        for (j = 0; j < row.idx.length; j++) acc += row.val[j] * v[row.idx[j]];
        w[i] = acc;
      }
      var nrm = 0;
      for (i = 0; i < n; i++) nrm += w[i] * w[i];
      nrm = Math.sqrt(nrm);
      if (nrm === 0) return 0;
      for (i = 0; i < n; i++) v[i] = w[i] / nrm;
      if (k >= 200) { s += Math.log(nrm); cnt++; }
    }
    return Math.exp(s / cnt);
  }

  function buildReservoir(cfg) {
    cfg = Object.assign({}, CFG, cfg || {});
    var r = rng(cfg.seed), n = cfg.n, i, j;
    var W = [];
    for (i = 0; i < n; i++) {
      var idx = [], val = [];
      for (j = 0; j < n; j++) if (r() < cfg.density) { idx.push(j); val.push(r() * 2 - 1); }
      W.push({ idx: idx, val: val });
    }
    var rho0 = spectralRadius(W, n), sc = cfg.rho / rho0;
    for (i = 0; i < n; i++) for (j = 0; j < W[i].val.length; j++) W[i].val[j] *= sc;
    var Win = [], b = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var row = new Float64Array(cfg.nIn);
      for (j = 0; j < cfg.nIn; j++) row[j] = (r() * 2 - 1) * cfg.inScale;
      Win.push(row);
      b[i] = (r() * 2 - 1) * cfg.biasScale;
    }
    var nnz = 0;
    for (i = 0; i < n; i++) nnz += W[i].idx.length;
    return { cfg: cfg, W: W, Win: Win, b: b, nnz: nnz, rho: spectralRadius(W, n) };
  }

  var _cache = {};
  function reservoir(cfg) {
    var key = JSON.stringify(cfg || {});
    if (!_cache[key]) _cache[key] = buildReservoir(cfg);
    return _cache[key];
  }

  // ---- 前処理：重力の平均を引いた「大きさ」と 3 軸（1 標本ずつ流せる）----
  function Preproc(cfg) {
    cfg = Object.assign({}, CFG, cfg || {});
    this.cfg = cfg; this.t = 0; this.m = null; this.mn = 0;
  }
  Preproc.prototype.push = function (s) {
    var x = +s[0], y = +s[1], z = +s[2];
    var nm = Math.sqrt(x * x + y * y + z * z);
    var tau = this.cfg.gravTau * this.cfg.rate;
    var a = Math.max(1 / (this.t + 1), 1 / tau);
    if (this.m === null) { this.m = [x, y, z]; this.mn = nm; }
    else {
      this.m[0] += a * (x - this.m[0]); this.m[1] += a * (y - this.m[1]); this.m[2] += a * (z - this.m[2]);
      this.mn += a * (nm - this.mn);
    }
    this.t++;
    var d = this.cfg.inputDiv;
    return [(nm - this.mn) / d, (x - this.m[0]) / d, (y - this.m[1]) / d, (z - this.m[2]) / d];
  };

  // ---- 動き続ける実行器（1 標本ずつ push。内部の状態と出力を返す）----
  function Runner(weights, cfg) {
    var res = reservoir(cfg || (weights && weights.cfg));
    this.res = res; this.cfg = res.cfg;
    this.x = new Float64Array(res.cfg.n);
    this.pre = new Preproc(res.cfg);
    this.wout = weights ? Float64Array.from(weights.wout) : null;
    this.feat = new Float64Array(res.cfg.n + 1 + res.cfg.nIn);
    this.step = 0;
  }
  Runner.prototype.push = function (s) {
    var res = this.res, n = res.cfg.n, nIn = res.cfg.nIn, a = res.cfg.leak, i, j;
    var u = this.pre.push(s), x = this.x, nx = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var acc = res.b[i], row = res.W[i], wi = res.Win[i];
      for (j = 0; j < row.idx.length; j++) acc += row.val[j] * x[row.idx[j]];
      for (j = 0; j < nIn; j++) acc += wi[j] * u[j];
      nx[i] = (1 - a) * x[i] + a * Math.tanh(acc);
    }
    this.x = x = nx;
    var f = this.feat;
    for (i = 0; i < n; i++) f[i] = x[i];
    f[n] = 1;
    for (j = 0; j < nIn; j++) f[n + 1 + j] = u[j];
    this.step++;
    var y = 0;
    if (this.wout) for (i = 0; i < f.length; i++) y += this.wout[i] * f[i];
    this.ys = this.step === 1 ? y : this.ys + res.cfg.outSmooth * (y - this.ys);   // 出力を少しならす
    return this.ys;
  };

  // ---- リッジ回帰（正規方程式をコレスキー分解で解く）----
  function ridgeSolve(rows, targets, lambda) {
    var m = rows.length, d = rows[0].length, i, j, k;
    var A = [], bvec = new Float64Array(d);
    for (i = 0; i < d; i++) A.push(new Float64Array(d));
    for (k = 0; k < m; k++) {
      var r = rows[k], t = targets[k];
      for (i = 0; i < d; i++) {
        var ri = r[i];
        bvec[i] += ri * t;
        for (j = 0; j <= i; j++) A[i][j] += ri * r[j];
      }
    }
    for (i = 0; i < d; i++) A[i][i] += lambda * m / 100;   // 標本数に比例させる
    // コレスキー分解 A = L L^T（下三角に L を入れる）
    for (i = 0; i < d; i++) {
      for (j = 0; j <= i; j++) {
        var s = A[i][j];
        for (k = 0; k < j; k++) s -= A[i][k] * A[j][k];
        if (i === j) { if (s <= 0) throw new Error('行列が正定値でない'); A[i][i] = Math.sqrt(s); }
        else A[i][j] = s / A[j][j];
      }
    }
    var z = new Float64Array(d), w = new Float64Array(d);
    for (i = 0; i < d; i++) { var s2 = bvec[i]; for (k = 0; k < i; k++) s2 -= A[i][k] * z[k]; z[i] = s2 / A[i][i]; }
    for (i = d - 1; i >= 0; i--) { var s3 = z[i]; for (k = i + 1; k < d; k++) s3 -= A[k][i] * w[k]; w[i] = s3 / A[i][i]; }
    return w;
  }

  // ---- 山の自動検出（印を付ける）----
  function findPeaks(samples, rate) {
    rate = rate || CFG.rate;
    var pre = new Preproc(), n = samples.length, sig = new Float64Array(n), i, k;
    for (i = 0; i < n; i++) sig[i] = pre.push(samples[i])[0];
    var w = Math.max(1, Math.round(rate * 0.1)), sm = new Float64Array(n);   // 約 0.1 秒の移動平均
    for (i = 0; i < n; i++) {
      var a = 0, c = 0;
      for (k = -w; k <= w; k++) if (i + k >= 0 && i + k < n) { a += sig[i + k]; c++; }
      sm[i] = a / c;
    }
    var skip = Math.round(rate * 0.5);   // 前処理の立ち上がりは見ない
    var abs = [];
    for (i = skip; i < n; i++) abs.push(Math.abs(sm[i]));
    abs.sort(function (p, q) { return p - q; });
    var ref = abs.length ? abs[Math.floor(abs.length * 0.95)] : 0;
    if (!(ref > 0.05)) return [];
    var thr = ref * 0.5, cand = [];
    for (i = skip + 1; i < n - 1; i++) if (sm[i] > thr && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) cand.push(i);
    cand.sort(function (p, q) { return sm[q] - sm[p]; });
    var minDist = Math.round(rate * 0.8), chosen = [];
    cand.forEach(function (c) {
      for (var q = 0; q < chosen.length; q++) if (Math.abs(chosen[q] - c) < minDist) return;
      chosen.push(c);
    });
    chosen.sort(function (p, q) { return p - q; });
    return chosen.map(function (c) { return c / rate; });   // 秒
  }

  // ---- 目標の波：印（秒）の上で 1・印と印の中間で 0。動きの外は 0 ----
  function targetWave(n, marks, rate) {
    var y = new Float64Array(n), m = marks.slice().sort(function (a, b) { return a - b; });
    var P = 0, i;
    for (i = 1; i < m.length; i++) P += m[i] - m[i - 1];
    P = P / (m.length - 1);
    var t0 = m[0] - P / 2, t1 = m[m.length - 1] + P / 2;
    for (i = 0; i < n; i++) {
      var t = i / rate;
      if (t < t0 || t > t1) { y[i] = 0; continue; }
      // 一番近い印からの位相。端では平均の周期で延ばす
      var j = 0, bd = 1e9, k;
      for (k = 0; k < m.length; k++) if (Math.abs(t - m[k]) < bd) { bd = Math.abs(t - m[k]); j = k; }
      var per = P;
      if (t >= m[j] && j + 1 < m.length) per = m[j + 1] - m[j];
      else if (t < m[j] && j > 0) per = m[j] - m[j - 1];
      y[i] = 0.5 * (1 + Math.cos(2 * Math.PI * (t - m[j]) / per));
    }
    return y;
  }

  // ---- 学習：samples=[[x,y,z],...]（50Hz）・marks=秒の配列（省略なら山から自動）----
  function train(samples, marks, opts) {
    opts = opts || {};
    var cfg = Object.assign({}, CFG, opts.cfg || {});
    var t0 = Date.now();
    var auto = false;
    if (!marks || marks.length < 2) { marks = findPeaks(samples, cfg.rate); auto = true; }
    if (marks.length < 2) throw new Error('動きの山が 2 つ以上見つかりません（動きが小さいか、回数が足りません）');
    var wave = targetWave(samples.length, marks, cfg.rate);
    var rows = [], tg = [], i, c, ar = rng(cfg.seed + 99);
    for (c = 0; c <= cfg.augCopies; c++) {      // c=0 は元の波・以後は雑音を足した写し
      var runner = new Runner(null, cfg);
      for (i = 0; i < samples.length; i++) {
        var s = samples[i];
        if (c > 0) s = [s[0] + cfg.augNoise * ar.gauss(), s[1] + cfg.augNoise * ar.gauss(), s[2] + cfg.augNoise * ar.gauss()];
        runner.push(s);
        if (i >= cfg.washout) { rows.push(Float64Array.from(runner.feat)); tg.push(wave[i]); }
      }
    }
    if (cfg.negSeconds > 0) {   // 動かない時の見本：3 軸それぞれの平均＋同じ大きさの雑音・目標は 0
      var sg = [0, 0, 0], mu = [0, 0, 0], k2;
      for (k2 = 0; k2 < 3; k2++) {
        var d = [], sm0 = 0;
        for (i = 0; i < samples.length; i++) sm0 += samples[i][k2];
        mu[k2] = sm0 / samples.length;
        for (i = 1; i < samples.length; i++) d.push(Math.abs(samples[i][k2] - samples[i - 1][k2]));
        d.sort(function (p, q) { return p - q; });
        sg[k2] = d[Math.floor(d.length / 2)] / 0.6745 / Math.SQRT2;   // 差分の中央値から雑音の大きさを見積もる
      }
      var runner2 = new Runner(null, cfg), nr = rng(cfg.seed + 5), nn = Math.round(cfg.negSeconds * cfg.rate);
      for (i = 0; i < nn; i++) {
        runner2.push([mu[0] + sg[0] * nr.gauss(), mu[1] + sg[1] * nr.gauss(), mu[2] + sg[2] * nr.gauss()]);
        if (i >= cfg.washout) { rows.push(Float64Array.from(runner2.feat)); tg.push(0); }
      }
    }
    var w = ridgeSolve(rows, tg, cfg.ridge), se = 0;
    for (i = 0; i < rows.length; i++) { var p = 0; for (var j = 0; j < w.length; j++) p += w[j] * rows[i][j]; se += (p - tg[i]) * (p - tg[i]); }
    return {
      cfg: cfg, wout: Array.from(w), marks: marks, auto_marks: auto,
      train_rmse: Math.sqrt(se / rows.length), n_train: rows.length, solve_ms: Date.now() - t0
    };
  }

  // ---- 数える：出力が上のしきい値を越えるたびに 1 回（ヒステリシス＋最短間隔）----
  function Counter(cfg) {
    cfg = Object.assign({}, CFG, cfg || {});
    this.cfg = cfg; this.count = 0; this.times = []; this.high = false; this.last = -1e9; this.i = 0;
  }
  Counter.prototype.push = function (y) {
    var t = this.i / this.cfg.rate, hit = false;
    this.i++;
    if (!this.high && y > this.cfg.hi) {
      this.high = true;
      if (t - this.last >= this.cfg.minGap) { this.count++; this.times.push(+t.toFixed(2)); this.last = t; hit = true; }
    } else if (this.high && y < this.cfg.lo) this.high = false;
    return hit;
  };

  // ---- まとめて数える ----
  function countReps(samples, weights) {
    var runner = new Runner(weights), c = new Counter(weights.cfg), ys = [];
    for (var i = 0; i < samples.length; i++) {
      var y = runner.push(samples[i]);
      ys.push(y);
      if (i >= runner.cfg.washout) c.push(y); else c.i++;
    }
    return { count: c.count, times_s: c.times, duration_s: +(samples.length / runner.cfg.rate).toFixed(2), outputs: ys };
  }

  // ---- 作り物のスクワット波形（画面の「見本の動き」・試験・MCP の例で使う）----
  // reps 回・1 回 period 秒（±jitter）・雑音 noise（m/s^2）。前後に lead/tail 秒の静止。
  function synthSquat(o) {
    o = Object.assign({ reps: 3, period: 2.0, jitter: 0.1, noise: 0.3, seed: 1, lead: 1.0, tail: 1.0, rate: 50, depth: 0.35 }, o || {});
    var r = rng(o.seed), rate = o.rate, out = [], marks = [], i;
    var g = [0.2, 0.35, 0.92], gn = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    g = g.map(function (v) { return v / gn * 9.81; });
    var dir = [0.05, 0.3, 0.95], dn = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    dir = dir.map(function (v) { return v / dn; });
    var plan = [], t = o.lead;
    for (i = 0; i < o.reps; i++) {
      var p = o.period * (1 + (r() * 2 - 1) * o.jitter);
      marks.push(+(t).toFixed(3));        // 山（加速度の最大）の時刻 = 1 回の区切り
      plan.push({ s: t - p / 2, e: t + p / 2, p: p, t: t });
      t += p;
    }
    var total = (plan.length ? plan[plan.length - 1].e : o.lead) + o.tail, N = Math.round(total * rate);
    var drift = [0, 0, 0], k;
    for (i = 0; i < N; i++) {
      var ti = i / rate, a = 0;
      for (k = 0; k < plan.length; k++) if (ti >= plan[k].s && ti < plan[k].e) {
        var ph = (ti - plan[k].t) / plan[k].p;
        var A = o.depth / 2 * Math.pow(2 * Math.PI / plan[k].p, 2);
        a = A * (Math.cos(2 * Math.PI * ph) + 0.25 * Math.sin(4 * Math.PI * ph));
      }
      var s = [];
      for (k = 0; k < 3; k++) {
        drift[k] = 0.995 * drift[k] + 0.012 * r.gauss();   // ゆっくりした手のゆれ
        s.push(g[k] + a * dir[k] + drift[k] + o.noise * r.gauss());
      }
      out.push(s);
    }
    return { samples: out, marks: marks, rate: rate, reps: o.reps };
  }

  var api = {
    CFG: CFG, rng: rng, reservoir: reservoir, Preproc: Preproc, Runner: Runner, Counter: Counter,
    ridgeSolve: ridgeSolve, findPeaks: findPeaks, targetWave: targetWave,
    train: train, countReps: countReps, synthSquat: synthSquat
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ESN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
