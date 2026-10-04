# 実装計画

フェーズ順に進める。各フェーズは単体で動作確認できる状態で終えること。

**進捗（2026-10-04 時点）**: Phase 1・2・4・5・6 完了。Phase 0 と Phase 3 は Orca の GUI でのプラグイン読み込みだけ未確認（理由は各項目に記載）。Phase 7 は README・スクリーンショット・配布用ツリーの生成まで完了、GitHub への公開は未実施。

---

## Phase 0: 未検証事項のスパイク（使い捨てコードで確認し、結果を CLAUDE.md に追記）

結果は CLAUDE.md の「Phase 0 スパイクの結果」に記載。

- [ ] ワーカーから `host.call('workspace.readContext')` を呼び、フォーカス中ワークツリーの `displayName` / `branch` が取れるか
  - 呼び出し経路と戻り値のスキーマ（`{ branch, displayName, terminals: [{ id }] } | null`）は Orca のソースと、本物のワーカーホストを使うハーネス（`packages/orca-plugin/scripts/host-harness.mjs`）で確認済み。**プラグインを Orca の UI から読み込んだときの実値は未確認**（CLI から読み込む手段がなく GUI 操作が必要）
- [x] コマンドに `context: "worktree"` を付けたとき、ハンドラの引数にワークツリー情報が渡るか → **渡らない**（引数は常に `undefined`）。readContext ＋突き合わせを採用
- [x] `orca worktree ps --json` の出力形式と、`displayName` での突き合わせが一意に決まるか → 同名は起こり得るので、readContext の terminal id と `orca terminal list` の `handle` / `ptyId` を照合するのを第一手段にし、displayName + branch を次点、それでも複数なら曖昧として通知
- [x] ワーカーの環境で `orca` コマンドが見つかるか。見つからない場合の既定インストール先 → 解決順は 設定 → `ORCA_CLI` → PATH → 既定インストール先。Windows の既定先を確認（macOS / Linux の候補は未検証の推測）
- [x] ワーカーから detached で起動したプロセスが、ワーカー停止後も生き残るか（Windows で特に確認）→ 生き残る
- [x] `process.execPath` ＋ `ELECTRON_RUN_AS_NODE=1` でサーバーを起動できるか → できる（Node 24.x として動作）
- [ ] 内蔵ブラウザタブで `<title>` がタブ名に反映されるか、アドレスバーの見え方
  - `orca tab list` の `title` には反映されることを確認。アドレスバーの見た目は未確認（`orca screenshot` はページ内容のみ）
- [x] 同じ URL で `tab create` を再実行したとき、新規タブになるか既存タブに切り替わるか → **新規タブになる**。`tab list` で探して `tab switch` / `goto` で再利用

## Phase 1: core（UI 非依存ロジック）

- [x] `git log --topo-order --format=<NUL区切り>` の出力パーサ（hash, parents, author, date, subject）
- [x] `git for-each-ref` で ref 一覧（ローカル / リモート / タグ / HEAD、upstream 情報付き）
- [x] **レーン配置アルゴリズム**: 各コミットの列位置、親への接続線（直線・分岐・合流）を計算する純粋関数
  - [x] 同じブランチはできるだけ同じ列を維持する（第1親は同じ列に残り、親に到達した時点で合流）
  - [x] マージで合流した列は空けて詰める
  - [x] 1万コミットで 200ms 以内（テストで検証）
- [x] 比較計算: 2つの ref について merge-base、A だけのコミット、B だけのコミット、ahead/behind 数（core にメモリ上の実装、server は git で計算。両者が一致することをテスト）
- [x] Vitest: 線形履歴、単純な分岐・マージ、octopus マージ、複数ルート、空リポジトリ、detached HEAD のテスト

**完了条件**: スナップショットテストでレーン配置が安定している ✅

## Phase 2: server ＋ web の単体動作（スクショの表形式を再現）

API（すべて `token` 必須）:

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/repo` | HEAD、ref 一覧、リモート一覧、作業ツリーの変更有無 |
| GET | `/api/log?limit=&cursor=` | コミット＋レーン情報（ページング） |
| GET | `/api/commit/:sha` | 詳細（メッセージ全文、親、変更ファイル一覧） |
| GET | `/api/compare?a=&b=` | merge-base、ahead/behind、片側のみのコミット |
| GET | `/api/diff/files?a=&b=&mode=three-dot\|two-dot` | 変更ファイル一覧（追加/削除行数つき） |
| GET | `/api/diff/file?a=&b=&path=` | 1ファイルの差分 |

実装では上記に加えて `/api/search`、`/api/worktree/files`、`/api/worktree/diff`、`POST /api/fetch`、`/api/events`（SSE）、`/api/health`、`/api/repos` がある。`/api/log` と `/api/search` は `types=` / `refs=` で表示範囲を絞れる。

UI:
- [x] 列: Graph / Description / Date / Author / Commit（参考: Zed の Git Graph）
- [x] ref バッジを種類ごとに見た目で区別: ローカルブランチ（塗り）、リモート（枠線＋クラウドアイコン）、タグ（タグアイコン）、HEAD（チェックマーク）。上流と同じコミットにある場合は 1 つのバッジに融合
- [x] コミット選択で下部に詳細ペイン（変更ファイル一覧 → クリックで差分）
- [x] 検索（メッセージ / 作者 / ハッシュ / ref 名）
- [x] 最上部に「未コミットの変更」行
- [x] ダーク / ライトテーマ（`prefers-color-scheme` 対応、手動切り替えあり）

**完了条件**: `pnpm dev -- --repo <path>` で通常ブラウザから表示でき、1万コミットのリポジトリでもスクロールが滑らか ✅
（Playwright / Chromium で計測: 1万1千コミットの初回表示 約 1 秒、スクロールのフレーム時間 p50 16.7ms / p95 33ms）

## Phase 3: Orca プラグイン（起動役）

- [x] `orca-plugin.json`: コマンド `open-git-graph`、キーバインド、capability は `workspace:read` と `notifications:show`
  - キーバインドは `Mod+Alt+Shift+O`。計画の例の `Mod+Alt+G` は同梱プラグインが使用済みのため変更。Orca 自身のバリデータでマニフェストが通ることを確認
- [x] `worker.mjs`: Phase 0 で確定した方法でワークツリーを特定 → サーバー起動 or 再利用 → `orca tab create`（既存タブがあれば切り替え）
- [x] サーバーのライフサイクル: ロックファイルで port/token を共有、ヘルスチェックで生存確認、一定時間（30 分）アクセスがなければ自動終了（ライブ更新の接続中は終了しない）
- [x] エラーは `notifications.show` で通知（Orca CLI が見つからない、リモートワークツリー、同名ワークツリー、サーバー起動失敗など）
- [ ] Orca の Settings → Plugins → Development で読み込んで動作確認
  - 代替として、Orca 本物のワーカーホスト（`plugin-host-entry.js`）上でビルド済みプラグインを動かすハーネスで通し確認済み（ワークツリー特定 → サーバー detached 起動 → タブ作成 → 再実行で既存タブに切替 → ワーカー停止後もサーバー生存）。配布用ツリーを `git clone --depth 1` したものでも同じ結果
  - GUI からの読み込みはまだ（手順: Settings → Plugins → Development に `packages/orca-plugin/dist` を追加）

**完了条件**: Orca 上でショートカット1回で、フォーカス中ワークツリーのグラフがタブで開く（上記 GUI 確認待ち）

## Phase 4: 比較モード（本ツールの主役）

- [x] ref バッジを2つクリック（または上部のセレクタ）で比較対象 A / B を選ぶ
- [x] プリセット: 「現在ブランチ ↔ upstream」「現在ブランチ ↔ main」「main ↔ origin/main」（重複する組み合わせは 1 つにまとめる）
- [x] グラフ上で A だけのコミットを色 A、B だけのコミットを色 B で強調し、共通の履歴は薄く表示
- [x] merge-base のコミットに目印
- [x] ヘッダに「A は B より 3 進んでいて 2 遅れている」を大きく表示
- [x] 変更ファイル一覧を変更量でソート、変更量を横棒で可視化
- [x] three-dot（分岐点から）/ two-dot（直接比較）の切り替え

**完了条件**: ローカルブランチ・リモートブランチ・タグのどの組み合わせでも比較できる ✅

## Phase 5: 自動更新とリモート

- [x] `.git/HEAD`、`.git/refs`、`.git/packed-refs` を監視し、SSE（`/api/events`）で UI に通知して差分更新（スクロール位置・選択・比較状態を保持）
- [x] worktree の場合は `.git` がファイルなので、実体の gitdir を解決して監視（リンクされた worktree でテスト）
- [x] 「Fetch」ボタン → `git fetch --all --prune`（進行中表示、失敗時はメッセージ）
- [x] ブランチ / タグでの表示フィルタ（種類別 ＋ ref ごと）

## Phase 6: 視覚的な見やすさの仕上げ

- [x] 色覚多様性に配慮したパレット（色だけに頼らず、線種・形でもレーンや比較側を区別）
- [x] ミニマップ（全体のどこを見ているか、比較で強調されたコミットの位置）
- [x] 表示密度の切り替え（コンパクト / 標準 / ゆったり）
- [x] キーボード操作（上下移動、Enter で詳細、`/` で検索、`c` で比較モード）
- [x] 日付の相対表示 / 絶対表示の切り替え

## Phase 7: 配布

- [ ] GitHub リリース（タグ付き）。Orca の「Git URL」からインストールできる形にする
  - Orca は指定した ref を `--depth 1` でクローンしてそのまま使うため、ビルド済みの配布用ツリーを別ブランチ（`plugin-dist`）／タグで公開する。`node scripts/release.mjs` が配布用ツリーを `release/` に作る（`--remote <url> --push` で公開）。**リモートリポジトリが未作成のため未公開**
  - `orca-plugin.json` の `publisher` は `mazume-tech-club`、`repository` は GitHub の実 URL に設定済み
- [x] README（日本語 / 英語）、スクリーンショットは架空のリポジトリで作成（`node scripts/screenshots.mjs`）
- [ ] 必要なら marketplace index リポジトリを作成（`publisher` に `stablyai`、id に `orca-` 接頭辞は使用禁止）→ 見送り

---

## テスト状況

`pnpm typecheck` / `pnpm test`（core 41、platform 10、server 44、orca-plugin 23、web 3）/ `pnpm test:e2e`（Playwright 21）がすべて通る。CI は `.github/workflows/ci.yml`（Windows / Ubuntu / macOS）に用意したが、まだ実行していない。macOS / Linux では未検証。
