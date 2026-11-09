# MCP サーバー（reservoir-squat-counter）

スクワットの加速度から回数を数える道具を、AI エージェントへ渡す口。MCP の stdio（JSON-RPC 2.0・1 行 1 メッセージ）・依存なし。動作確認は node v22.22.3 だけ（18 などは未確認）。
計算は `../app/esn.js` を import して使う（画面と同じ物）。ネットには出ない。

## 起動

```
node mcp/server.mjs
```

MCP クライアントの設定の例（パスは自分の場所に直す）:

```json
{ "mcpServers": { "squat": { "command": "node", "args": ["/絶対パス/work_d_squat/mcp/server.mjs"] } } }
```

## 道具

| 名前 | 入力 | 出力 |
|---|---|---|
| `train` | `samples`（[x,y,z] の列・重力込み・m/s^2）・`sample_rate_hz`（既定 50）・`marks_s`（省略可＝山から自動） | `weights`（cfg と wout）・`marks_s`・`train_rmse`・`solve_ms` |
| `count_reps` | `samples`・`weights` または `train_samples`（その場で学習）・各 `sample_rate_hz` | `count`・`times_s`（各回の時刻・秒）・`duration_s` |

標本は 50Hz を想定する。違う値を `sample_rate_hz` で渡すと直線補間で 50Hz に直す。
入力が不正なときは `isError: true` で理由を返す。

## 動作の確かめ

`node test/mcp_session.mjs` が server.mjs を実際に起こし、initialize → tools/list → tools/call（作り物の波）を流して答えを表示する。
