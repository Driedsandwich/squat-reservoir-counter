#!/usr/bin/env node
// MCP（Model Context Protocol）の stdio サーバー。JSON-RPC 2.0・1 行 1 メッセージ・依存なし。
// 道具：train（3 回分の加速度 → 重み）・count_reps（加速度 → 回数と各回の時刻）
import ESN from '../app/esn.js';
import readline from 'node:readline';

const SERVER = { name: 'reservoir-squat-counter', version: '1.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const samplesSchema = {
  type: 'array', description: '加速度の列。1 要素は [x, y, z]（m/s^2・重力込み＝DeviceMotionEvent の accelerationIncludingGravity と同じ）。',
  items: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
};
const TOOLS = [
  {
    name: 'train',
    description: '3 回分ほどのスクワットの加速度から、リザバーの出力の重み（リッジ回帰）を学習して JSON で返す。印（1 回ごとの時刻）を省くと、波の山から自動で付ける。',
    inputSchema: {
      type: 'object', required: ['samples'],
      properties: {
        samples: samplesSchema,
        sample_rate_hz: { type: 'number', description: '標本の間隔の逆数（既定 50）。50 と違うときは 50Hz に直して使う。' },
        marks_s: { type: 'array', items: { type: 'number' }, description: '1 回ごとの印の時刻（秒・先頭の標本が 0 秒）。省略なら自動。' }
      }
    }
  },
  {
    name: 'count_reps',
    description: '加速度の列からスクワットの回数と各回の時刻（秒）を数える。学習済みの weights を渡すか、学習用の 3 回分 train_samples を渡す（その場で学習してから数える）。',
    inputSchema: {
      type: 'object', required: ['samples'],
      properties: {
        samples: samplesSchema,
        sample_rate_hz: { type: 'number', description: '既定 50' },
        weights: { type: 'object', description: 'train の返した JSON' },
        train_samples: samplesSchema,
        train_sample_rate_hz: { type: 'number', description: '既定 50' },
        train_marks_s: { type: 'array', items: { type: 'number' }, description: '学習用の印（秒）。省略なら自動。' }
      }
    }
  }
];

function resample(samples, rate) {            // 50Hz へ直線補間で直す
  const R = ESN.CFG.rate;
  if (!rate || Math.abs(rate - R) < 1e-6) return samples;
  const n = Math.floor((samples.length - 1) * R / rate) + 1, out = [];
  for (let i = 0; i < n; i++) {
    const p = i * rate / R, a = Math.floor(p), b = Math.min(a + 1, samples.length - 1), f = p - a;
    out.push([0, 1, 2].map((k) => samples[a][k] * (1 - f) + samples[b][k] * f));
  }
  return out;
}
function needSamples(v, name) {
  if (!Array.isArray(v) || v.length < 100) throw new Error(`${name} は 100 標本（50Hz で 2 秒）以上の配列が必要です`);
  for (const s of v) if (!Array.isArray(s) || s.length !== 3 || s.some((x) => typeof x !== 'number' || !isFinite(x))) throw new Error(`${name} の各要素は数 3 つの [x, y, z] にしてください`);
  return v;
}

function callTool(name, a) {
  a = a || {};
  if (name === 'train') {
    const s = resample(needSamples(a.samples, 'samples'), a.sample_rate_hz);
    const w = ESN.train(s, a.marks_s && a.marks_s.length >= 2 ? a.marks_s : null);
    return { weights: { cfg: w.cfg, wout: w.wout }, marks_s: w.marks, marks_were_automatic: w.auto_marks, train_rmse: +w.train_rmse.toFixed(4), solve_ms: w.solve_ms };
  }
  if (name === 'count_reps') {
    const s = resample(needSamples(a.samples, 'samples'), a.sample_rate_hz);
    let weights = a.weights, trained = false;
    if (!weights) {
      if (!a.train_samples) throw new Error('weights か train_samples のどちらかが必要です');
      const ts = resample(needSamples(a.train_samples, 'train_samples'), a.train_sample_rate_hz);
      const w = ESN.train(ts, a.train_marks_s && a.train_marks_s.length >= 2 ? a.train_marks_s : null);
      weights = { cfg: w.cfg, wout: w.wout }; trained = true;
    }
    if (!weights.wout || !weights.cfg) throw new Error('weights は train が返した JSON（cfg と wout）をそのまま渡してください');
    const r = ESN.countReps(s, weights);
    return { count: r.count, times_s: r.times_s, duration_s: r.duration_s, trained_from_train_samples: trained };
  }
  throw new Error('知らない道具: ' + name);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: 'スマホの加速度からスクワットの回数を数える。train で重みを作り count_reps で数える（train_samples を渡せば 1 回で済む）。'
      } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      let out;
      try {
        const r = callTool(params && params.name, params && params.arguments);
        out = { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r, isError: false };
      } catch (e) {
        out = { content: [{ type: 'text', text: String(e.message || e) }], isError: true };
      }
      return send({ jsonrpc: '2.0', id, result: out });
    }
    if (isNotification) return;   // notifications/initialized など
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
});
