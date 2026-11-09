// 試験：node test/test.mjs  （依存なし・乱数の種は固定）
import ESN from '../app/esn.js';

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!ok) fails++;
}

// 0. 部品の確かめ
const res = ESN.reservoir();
check('内部の数 100・疎（結合の割合 5〜15%）', res.cfg.n === 100 && res.nnz / 10000 > 0.05 && res.nnz / 10000 < 0.15, `nnz=${res.nnz}`);
// スペクトル半径を別の方法（行列を 256 乗してノルムの 256 乗根）で確かめる
{
  const n = 100;
  let M = Array.from({ length: n }, () => new Float64Array(n));
  res.W.forEach((row, i) => row.idx.forEach((j, k) => { M[i][j] = row.val[k]; }));
  for (let it = 0; it < 8; it++) {
    const N = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const a = M[i][k]; if (a !== 0) for (let j = 0; j < n; j++) N[i][j] += a * M[k][j]; }
    let f = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) f += N[i][j] ** 2;
    f = Math.sqrt(f);
    // 正規化して対数で持ち回る
    M = N.map((r) => r.map((v) => v / f));
    globalThis.__lg = ((globalThis.__lg || 0) * 2) + Math.log(f);
  }
  // M は毎回割っているので、log||W^256|| = __lg の累積（各段で 2 倍して足した値）
  const rho = Math.exp(globalThis.__lg / 256);
  check('スペクトル半径が 0.9 前後（別法の見積もり）', rho > 0.86 && rho < 0.97, `別法=${rho.toFixed(3)} 本体=${res.rho.toFixed(3)}`);
}
{ // リッジ回帰の自前ソルバーを既知の答えで確かめる
  const r = ESN.rng(3), truth = [2, -1, 0.5], rows = [], t = [];
  for (let i = 0; i < 200; i++) { const x = [r.gauss(), r.gauss(), 1]; rows.push(x); t.push(x[0] * 2 - x[1] + 0.5); }
  const w = ESN.ridgeSolve(rows, t, 1e-9);
  check('リッジ回帰の自前ソルバーが既知の係数を返す', truth.every((v, i) => Math.abs(v - w[i]) < 1e-3), Array.from(w).map((v) => v.toFixed(3)).join(','));
}
{ // 同じ種なら同じ重み
  const s = ESN.synthSquat({ reps: 3, period: 2.0, seed: 11 });
  const a = ESN.train(s.samples), b = ESN.train(s.samples);
  check('同じ入力・同じ種なら同じ重み', a.wout.every((v, i) => v === b.wout[i]));
}

// 1. 本体：3 回分で学習 → 数える
const trainSig = ESN.synthSquat({ reps: 3, period: 2.0, seed: 11 });
const wAuto = ESN.train(trainSig.samples);               // 山から自動で印
const wTap = ESN.train(trainSig.samples, trainSig.marks); // 利用者がたたいた印（ここでは正解の印）
console.log(`学習：自動の印=${wAuto.marks.map((m) => m.toFixed(2))} 正解=${trainSig.marks}  解くのにかかった時間=${wAuto.solve_ms}ms  学習誤差(RMSE)=${wAuto.train_rmse.toFixed(3)}`);
const cases = [
  { reps: 10, period: 1.6, seed: 21 }, { reps: 10, period: 2.0, seed: 22 }, { reps: 10, period: 2.4, seed: 23 },
  { reps: 20, period: 1.7, seed: 24 }, { reps: 20, period: 2.2, seed: 25 }, { reps: 20, period: 2.6, seed: 26 },
];
for (const [label, w] of [['自動の印', wAuto], ['たたいた印', wTap]]) {
  for (const c of cases) {
    const sig = ESN.synthSquat({ ...c, noise: 0.3 });
    const r = ESN.countReps(sig.samples, w);
    check(`${label}で学習→${c.reps}回(1回${c.period}秒)を数える ±1以内`, Math.abs(r.count - c.reps) <= 1, `数えた=${r.count} 正解=${c.reps}`);
  }
}
// 2. 対照：動かない信号（雑音だけ）は 0 回
for (const sd of [31, 32, 33]) {
  const still = ESN.synthSquat({ reps: 0, lead: 20, tail: 0, seed: sd, noise: 0.3 });
  const r = ESN.countReps(still.samples, wAuto);
  check(`対照：動かない信号20秒(種${sd})は 0 回`, r.count === 0, `数えた=${r.count}`);
}
// 3. 対照の対照：同じ道具が動く信号では 0 でない（道具が壊れて常に 0 を返していないことの確認）
{
  const r = ESN.countReps(ESN.synthSquat({ reps: 10, period: 2.0, seed: 41 }).samples, wAuto);
  check('対照の対照：動く信号では 5 回以上数える', r.count >= 5, `数えた=${r.count}`);
}
// 4. 最短間隔：1 秒より短い間隔は数えない
{
  const c = new ESN.Counter(); let n = 0;
  for (const y of [0, 0.9, 0.1, 0.9, 0.1, 0, 0]) { if (c.push(y)) n++; }   // 5 サンプル(0.1秒)の間に 2 回上がる
  check('最短間隔 1 秒より短い再上昇は数えない', n === 1, `数えた=${n}`);
}
console.log(fails === 0 ? '\n全部通った' : `\n失敗 ${fails} 件`);
process.exit(fails === 0 ? 0 : 1);
