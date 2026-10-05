# Publishing and announcing

How a release gets to users, and the text to share. Nothing here is automated: publishing and posting are
deliberate, manual steps.

## 1. Publish the install branch

Orca installs a plugin from a Git URL by shallow-cloning a ref and using the tree **as it is** (no build step), so the
ref must hold the built files at its root. That tree lives on its own branch, `plugin-dist`, separate from `main`.

```sh
pnpm install
node scripts/release.mjs                       # builds, creates ./release (one commit, tag plugin-v<version>)
git -C release ls-files                        # check: orca-plugin.json worker.mjs open.mjs server.mjs web/ ...
node scripts/release.mjs --skip-build \
  --remote https://github.com/mazume-tech-club/orca-git-graph.git --push   # force-pushes plugin-dist + the tag
```

The same tree is also what the *standalone* install in the README clones, so one branch serves both audiences.

Install, as users see it (Orca → Settings → Plugins → Install from Git URL):

The dialog has a single field and requires an explicit `#ref` (a tag or a commit) so the install is pinned:

```
https://github.com/mazume-tech-club/orca-git-graph#plugin-v0.1.0
```

Use the tag (or a commit hash). Whether a branch name such as `#plugin-dist` is accepted is unverified, so the README only documents tags.
A tag that is force-moved changes what an existing pin means: for a real release, bump the version and publish a new tag.

Before the first release: check `packages/orca-plugin/orca-plugin.json` (`publisher`, `repository`, `version`), run
`pnpm test && pnpm test:e2e`, and try the built plugin once in Orca (`packages/orca-plugin/dist` via Settings → Plugins → Development).

## 1b. Publish the npm package (standalone use: `npx orca-git-graph` / `git graph`)

`pnpm build` also produces the npm package in `packages/cli/dist` (the bundled server with a shebang, the web UI, and
two bins: `orca-git-graph` and `git-graph`, so that `git graph` works as a Git subcommand once it is on `PATH`).
The name `orca-git-graph` was free on the registry when this was written (check again before publishing).

```sh
pnpm build
cd packages/cli/dist
npm pack --dry-run          # check the file list (server.mjs, web/, docs/, README.md, LICENSE, package.json)
npm publish                 # needs `npm login`; the version comes from packages/cli/package.json
```

Check a built package without publishing: `npm pack`, then `npm install -g --prefix <tmp> ./orca-git-graph-0.1.0.tgz`.

Once published, add this to the top of the README (it is intentionally not there yet, because it would not work):

```sh
npx orca-git-graph                    # inside any repository: opens your browser
npm i -g orca-git-graph && git graph  # or install once and use it as a Git subcommand
```

## 2. Get listed in Orca's plugin marketplace

The official index is the file `orca-marketplace.json` in the `stablyai/orca-plugins` repository; an entry is added by
pull request (ask in Orca's community channels first about the current process). The entry for this plugin:

```json
{
  "id": "mazume-tech-club.git-graph",
  "source": {
    "kind": "git",
    "url": "https://github.com/mazume-tech-club/orca-git-graph.git",
    "ref": "plugin-v0.1.0"
  },
  "description": "Commit graph in an editor tab: all branches, remotes and tags, and ahead/behind comparison between any two refs.",
  "categories": ["git", "visualization"]
}
```

Notes: `id` must equal `<publisher>.<id>` of the manifest; `ref` must be a named ref (a tag, so the listing is reproducible);
the plugin must not use the `stablyai` publisher or an `orca-` id prefix.

## 3. Announcement drafts

Post these yourself, and look at the community rules first. Use the GIF from `docs/images/`.

**Short (X / chat), English**

> Built a Git graph for @orca: every branch, remote and tag on one screen, and pick any two refs to see "main is 3 ahead, 2 behind origin/main" with the commits only in A / only in B highlighted. Opens as an editor tab — or runs standalone in any browser, no Orca needed. Read-only, local only, MIT.
> https://github.com/mazume-tech-club/orca-git-graph

**Short (X / chat), 日本語**

> Orca 向けの Git グラフを作りました。全ブランチ・リモート・タグを一画面で表示し、任意の 2 つの ref を選ぶと「main は origin/main より 3 進んで 2 遅れ」と、A だけ・B だけのコミットを強調表示します。エディタのタブとして開けます。Orca なしでもブラウザ単体で動きます。読み取り専用・ローカルのみ・MIT。
> https://github.com/mazume-tech-club/orca-git-graph

**Discord / forum post (longer)**

> **Git Graph — a visual commit graph for Orca (and for any browser)**
>
> What it does
> - all branches, remote branches and tags in one lane graph, plus an "uncommitted changes" row
> - compare any two refs: ahead/behind in words and numbers, commits only in A / only in B, the merge base marked, a changed-files list with a size bar, `A...B` or `A..B`
> - readable without colour (A = circle, B = square, merge base = diamond, plus letters), colour-blind-safe palette
> - live refresh when refs change (keeps scroll position and your comparison); Fetch only when you press the button
> - 10k-commit repositories open in about a second
>
> Install: Settings → Plugins → Install from Git URL → `https://github.com/mazume-tech-club/orca-git-graph#plugin-v0.1.0`.
> Standalone (no Orca): `node server.mjs --open` inside any repository — see the README.
>
> It is read-only apart from an explicit Fetch button, binds to 127.0.0.1 only with a random token per run, and runs git via `execFile`.
> Feedback welcome, especially on macOS / Linux, which I have not been able to test.

## 3b. Orca feature request

`docs/ORCA-FEATURE-REQUEST.md` is a ready-to-file draft for `stablyai/orca` (plugin buttons, shortcuts that work in
terminals, worktree passed to commands, and the slow no-tab `orca tab list` / minimal worker environment findings).

## 4. Things to say honestly

- Orca's plugin API is experimental; the plugin was built and tested against Orca 1.4.x on Windows.
- Plugins cannot add buttons or toolbar items; the entry points are the command palette, a shortcut (not while a
  terminal has focus) and an optional Quick Command running `node <plugin>/open.mjs`.
- Only local worktrees are supported.
