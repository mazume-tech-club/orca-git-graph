# orca-git-graph

Orca（stablyai/orca）で、Git のコミットグラフを**エディタ領域の新規タブ**として開くツール。
視覚優位者向けに「一画面で全体が分かる」「ブランチ・リモートとの差分がひと目で分かる」ことを最優先にする。

実装計画は `docs/PLAN.md`。作業はフェーズ順に進め、各フェーズの完了条件を満たしてから次へ進むこと。

## 目的と非目的

**目的**
- 全ブランチ・リモートブランチ・タグを含むリポジトリ全体のグラフを、広い画面で表示する
- 任意の2つの ref（ローカルブランチ、リモートブランチ、タグ、HEAD）を比較し、ahead/behind・片側にだけあるコミット・変更ファイル・差分を視覚的に示す
- Orca のコマンド（ショートカット / コマンドパレット）からワンアクションで、フォーカス中ワークツリーのグラフをタブで開く

**非目的（初期スコープ外）**
- checkout / commit / rebase / push などリポジトリを変更する操作（`git fetch` のみ例外。明示的なボタン操作時だけ実行）
- SSH・リモート Orca サーバー上のワークツリー（ローカルのみ対応し、それ以外は説明メッセージを表示）
- Orca のサイドバーパネル内での表示

## アーキテクチャ

```
[packages/orca-plugin]  Orca プラグイン（起動役のみ）
   コマンド「Git Graph を開く」
   1. host.call('workspace.readContext') → { displayName, branch }
   2. `orca worktree ps --json` と突き合わせて path / id を特定
   3. サーバー未起動なら detached プロセスとして起動（ロックファイルで port/token 共有）
   4. `orca tab create --url http://127.0.0.1:<port>/?repo=<id>&token=<token> --worktree id:<id> --json`

[packages/server]  ローカル HTTP サーバー（Hono）
   git CLI を execFile で実行 → JSON API / SSE

[packages/web]  React UI（Orca 内蔵ブラウザのタブで表示。通常ブラウザでも動く）

[packages/core]  UI 非依存のロジック（git 出力パーサ、レーン配置、比較計算、API の型）

[packages/platform]  server と orca-plugin が共有する Node 向け部品（データディレクトリ、ロックファイル、orca CLI 呼び出し）
                     orca CLI を実行するのは `orca.ts` だけ（差し替えやすくするため）
```

`server` と `web` は Orca なしでも単体で動くこと（`pnpm dev -- --repo <path>`）。Orca 依存は `orca-plugin` に閉じ込める。

## 検証済みの Orca の事実（Orca 1.4.x / Windows で確認、2026-10-04）

- `orca tab create --url http://127.0.0.1:<port> --worktree <selector> --json` で内蔵ブラウザのタブが開き、localhost のページを読み込める
- `orca worktree current --json` / `worktree show` の結果に `result.worktree.path` と `result.worktree.id`（形式: `<repoId>::<absolutePath>`）が含まれる
- `--worktree active` / `current` は**シェルのカレントディレクトリから解決**される。ワークツリー外（例: `C:\`）では `selector_not_found` になる。ワーカーからは使わず、`id:` か `path:` の明示セレクタを使うこと
- コミットが1つもないリポジトリでは `head` / `branch` が空文字になる（Orca の出力。git 側の `symbolic-ref` は unborn ブランチ名を返す）

### Phase 0 スパイクの結果（Orca 1.4.220 / Windows 11、2026-10-04）

- **コマンドハンドラには引数が渡らない**。`context: "worktree"` を付けても同じ（レンダラーは `invokeCommand({ pluginKey, commandId })` しか送らない）。フォーカス中のワークツリーは `workspace.readContext` でしか分からない
- `workspace.readContext` の戻り値は `{ branch, displayName, terminals: [{ id }] } | null`（ワークツリー id は含まれない）。突き合わせは **terminal の id を `orca terminal list` の `handle` / `ptyId` と照合**するのが最も確実。次に displayName + branch。同名が複数なら曖昧として通知する
- `orca worktree ps --json` の要素: `worktreeId`（`<repoId>::<path>`）、`repoId`、`hostId`（`local` 以外はリモート）、`workspaceKind`（`git` 以外は Git リポジトリではない）、`displayName`、`branch`、`path`
- `orca tab create` は同じ URL でも**毎回新しいタブを作る**。`orca tab list --worktree id:<id> --json` の `tabs[].url` / `title`（`<title>` が反映される）で既存タブを探し、`tab switch --page <id>`（URL が古ければ `goto --page <id> --url`）で再利用する
- **ブラウザタブ系の CLI（`tab list` / `switch` / `show` / `current`）は、そのワークツリーにブラウザタブが 1 つも無いと毎回約 8.4 秒かかる**（Orca がブラウザブリッジを待つ）。`tab create` は 0.5 秒で終わる。タブがあるときは list 0.35 秒 / switch 0.7 秒。→ サーバーの `/api/clients`（画面が開いていれば SSE 接続が 1 以上）で「開いているか」を先に確認し、開いていなければ `tab list` を呼ばず直接 `tab create` する
- `orca` CLI 1 回の起動は約 0.3〜0.4 秒。プラグインのワーカーは **USERPROFILE / APPDATA / LOCALAPPDATA の無い最小の環境変数**で起動され、そのままだと `orca` CLI が失敗する（`cliEnv()` で補う）
- ワーカーから `detached: true, stdio: 'ignore'` で起動した子プロセスは、親（ワーカー）が終了しても生き残る（Windows で確認）
- ワーカー内の `process.execPath` は Orca 本体の実行ファイル。`ELECTRON_RUN_AS_NODE=1` を付ければ素の Node（24.x）として動くので、ユーザーに Node は不要
- Orca の Git URL インストールは `git clone --depth 1 --branch <ref>` したツリーを**そのまま**使う（ビルドしない）。ref のルートに `orca-plugin.json` とビルド済みの `worker.mjs` / `server.mjs` / `web/` が必要 → `scripts/release.mjs` で配布用ツリーを作る
- マニフェストの `capabilities` は文字列ではなく `[{ "kind": "workspace:read" }]` の形式。`keybindings[].key` は `Mod+Alt+Shift+O` 形式。**`Mod+Alt+G` は同梱プラグイン（navigation-shortcuts）が使用済み**
- 開発用プラグインの読み込みは Orca の Settings → Plugins → Development（`devPluginPaths`）。CLI からは読み込めない。ワーカーホストの検証は `packages/orca-plugin/scripts/host-harness.mjs`（Orca 本物の `plugin-host-entry.js` を使う）で代替できる
- 未確認: プラグインを実際に Orca へ読み込んだときの `readContext` の実値、内蔵ブラウザのアドレスバーの見え方、macOS / Linux

## Orca プラグイン API v0 の制約（stablyai/orca `src/shared/plugins/*` より）

- マニフェストは `orca-plugin.json`。`manifestVersion: 1`、`pluginApi: 1`、`engines.orca: ">=x.y.z"` 形式のみ
- capability は7種類のみ: `workspace:read`, `terminal:send`, `notifications:show`, `storage`, `secrets`, `events:subscribe`, `settings:own`。本プロジェクトで使うのは `workspace:read` と `notifications:show`
- ワーカー（`main`）は子プロセスで動く ES モジュール。`export default async function activate(ctx)` で `ctx.commands.register(id, handler)` を呼ぶ。マニフェストで宣言したコマンドは必ず登録すること（未登録だと起動失敗）
- **ワーカーはアイドル60秒で停止される**。HTTP サーバーをワーカー内で動かさないこと。`detached: true, stdio: 'ignore'` で別プロセスとして起動し `unref()` する
- ワーカーから `child_process` を使えるのは現状の実装上の挙動で、公式に保証されていない（将来 `process:exec` capability で制限される可能性がある）。外部コマンド実行は1モジュールに集約し、差し替えやすくしておくこと
- パネル（サイドバー）はネットワーク不可・`window.open` 無効・ワーカーと通信不可なので使わない
- API 全体が experimental。バージョン依存の箇所にはコメントで根拠を書くこと

## 技術スタック

- 言語: TypeScript（`strict: true`）。Node.js 20 以上
- パッケージ管理: pnpm workspace
- サーバー: Hono（`@hono/node-server`）
- UI: React + Vite。グラフは SVG ＋行の仮想スクロール（`@tanstack/react-virtual`）
- 差分表示: diff2html
- テスト: Vitest（core / server）、Playwright（web）
- バンドル: esbuild（server と orca-plugin を単一ファイルに）

## 実装ルール

- **git は必ず `execFile('git', [...args])` で実行する**。`shell: true` や文字列連結でのコマンド組み立ては禁止。ユーザー入力（ref 名など）は `git check-ref-format` 相当の検証、または `--end-of-options` を付けて渡す
- git 出力のパースは NUL 区切り（`%x00`）と `-z` オプションを使い、改行やスペースを含むメッセージ・パスでも壊れないようにする
- Windows を第一ターゲットとする（パス区切り、改行コード、`fs.watch` の挙動）。macOS / Linux でも動くこと
- `orca` CLI は PATH にある前提にしない。解決順: 設定値 → PATH → OS ごとの既定インストール先
- 大きいリポジトリ（1万コミット以上）でも初回表示が2秒以内を目標にし、ページング取得する
- 他ツールのコードは流用しない。特に VS Code Git Graph（mhutchie）は派生物の配布が許可されていないため、コードを読んでコピーすることも避ける

## セキュリティ

- サーバーは `127.0.0.1` のみで待ち受ける（`0.0.0.0` / `::` は禁止）
- 起動ごとにランダムなトークンを生成し、全 API で検証する（クエリかヘッダ）
- `repo` パラメータは任意のパスを受け付けない。`orca worktree ps` で得たワークツリー、または起動時に指定したパスの許可リストに含まれるものだけ扱う
- 既定は読み取り専用。`git fetch` は UI の明示的なボタン操作時のみ実行する
- ロックファイル（port/token）はユーザーのデータディレクトリに置き、他ユーザーから読めない権限にする

## よく使うコマンド

（実装に合わせて更新すること）

```
pnpm install
pnpm dev -- --repo C:\path\to\repo     # server + web（Vite, HMR）を単体起動。URL が表示される
pnpm test                              # core / platform / server / orca-plugin / web の単体テスト
pnpm typecheck
pnpm build                             # web → server → orca-plugin/dist（配布物）
pnpm test:e2e                          # Playwright（先に pnpm build。初回は playwright install chromium）
node scripts/make-demo-repo.mjs <dir>  # 架空のデモリポジトリ（ahead/behind、マージ、タグ入り）
node scripts/make-large-repo.mjs <dir> 10000
node scripts/screenshots.mjs           # docs/images を再生成
node packages/orca-plugin/scripts/host-harness.mjs   # 起動中の Orca でプラグインを通し確認（実際にタブが開く）
node scripts/release.mjs               # 配布用ツリー（Git URL インストール用）を release/ に作る
```

## 完了の定義（各フェーズ共通）

- `pnpm test` と `pnpm typecheck` が通る
- Windows 上で実際に動作確認した
- `docs/PLAN.md` の該当フェーズのチェックボックスを更新した
