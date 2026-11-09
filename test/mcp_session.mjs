// MCP を実際に node で起こし、標準入力から initialize → tools/list → tools/call を流して答えを出す
import { spawn } from 'node:child_process';
import ESN from '../app/esn.js';
const round = (s) => s.map((v) => v.map((x) => +x.toFixed(3)));
const train = ESN.synthSquat({ reps: 3, period: 2.0, seed: 11 });
const run = ESN.synthSquat({ reps: 12, period: 1.8, seed: 51 });
const still = ESN.synthSquat({ reps: 0, lead: 15, tail: 0, seed: 52 });
const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'count_reps', arguments: { samples: round(run.samples), train_samples: round(train.samples) } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'train', arguments: { samples: round(train.samples) } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'count_reps', arguments: { samples: round(still.samples), train_samples: round(train.samples) } } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'count_reps', arguments: { samples: [[0, 0, 1]] } } },
  { jsonrpc: '2.0', id: 7, method: 'nope' },
];
const p = spawn('node', [new URL('../mcp/server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const got = [];
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
p.on('close', () => {
  const byId = Object.fromEntries(got.map((g) => [g.id, g]));
  // 4 番の答え（重み）は長いので、その後 count_reps に重みを渡す経路も確かめたあとで要約表示
  console.log('--- initialize の答え ---'); console.log(JSON.stringify(byId[1].result));
  console.log('--- tools/list の道具名 ---'); console.log(byId[2].result.tools.map((t) => t.name).join(', '));
  console.log('--- count_reps（作り物の波 12 回・1 回 1.8 秒・train_samples で学習）の答え ---'); console.log(JSON.stringify(byId[3].result.structuredContent));
  const tw = byId[4].result.structuredContent;
  console.log('--- train の答え（重みは長いので先頭 3 つだけ）---'); console.log(JSON.stringify({ ...tw, weights: { cfg: '…', wout: tw.weights.wout.slice(0, 3).map((v) => +v.toFixed(4)).concat(['…', tw.weights.wout.length + ' 個']) } }));
  console.log('--- count_reps（動かない信号 15 秒）の答え ---'); console.log(JSON.stringify(byId[5].result.structuredContent));
  console.log('--- 誤った入力（標本が少ない）→ isError ---'); console.log(JSON.stringify(byId[6].result));
  console.log('--- 知らないメソッド ---'); console.log(JSON.stringify(byId[7].error));
  console.log('返答の数', got.length, '（通知には返さない：送った 8 通のうち id 付き 7 通）');
  // 学習済みの重みを渡す経路
  const p2 = spawn('node', [new URL('../mcp/server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
  let b2 = ''; p2.stdout.on('data', (d) => { b2 += d; });
  p2.on('close', () => { console.log('--- count_reps（train の重みを weights で渡す）の答え ---'); console.log(JSON.stringify(JSON.parse(b2.trim()).result.structuredContent)); });
  p2.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'count_reps', arguments: { samples: round(run.samples), weights: tw.weights } } }) + '\n');
});
p.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
