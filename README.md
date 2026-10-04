# orca-git-graph

[日本語](README.ja.md)

A Git commit graph for [Orca](https://github.com/stablyai/orca), opened as a **tab in the editor area**. Built for people who think visually: the whole repository on one screen, and the difference between any two branches, remotes or tags at a glance.

![Compare main with origin/main](docs/images/compare-en-dark.png)

## What you get

- **The whole repository** — all local branches, remote branches and tags in one lane graph (with merge commits, octopus merges, multiple roots), plus a row for uncommitted changes.
- **Compare any two refs** — pick A and B (local branch, remote branch, tag, `HEAD`) by clicking ref badges or from the selectors. The header says it in words and numbers (*"main is 3 ahead and 2 behind of origin/main"*), the graph highlights commits only in A / only in B, marks the merge base, and dims the shared history. Changed files are sorted by size with a bar per file. Switch between `A...B` (from the merge base) and `A..B` (direct).
- **Readable without colour** — A is a circle, B a square, the merge base a diamond, each also carries a letter; lanes use a colour-blind-safe palette and change dash pattern when colours repeat.
- **Stays current** — watches `.git` (including linked worktrees) and updates in place, keeping your scroll position, selection and comparison. A **Fetch** button runs `git fetch --all --prune`; it is the only thing that ever changes your repository, and only when you press it.
- **Fast** — paged loading and a virtualised list: first screen of a 10,000-commit repository in about a second, smooth scrolling. A minimap shows where the compared commits and refs are in the whole history.
- Search (message, author, hash, ref name), per-ref filter, density / relative-or-absolute dates / light-dark themes, keyboard control.

## Install (as an Orca plugin)

1. Orca → **Settings → Plugins → Install from Git URL**
2. URL: `https://github.com/<owner>/orca-git-graph`, Ref: `plugin-dist` (or a release tag such as `v0.1.0`)
3. Approve the two capabilities it asks for: *read the focused worktree's name/branch* and *show notifications*.
4. Run **Open Git Graph** from the command palette, or press **Ctrl/Cmd + Alt + Shift + O**.

Plugin shortcuts do not fire while a terminal has focus, and Orca's plugin API cannot add buttons. As a one-click alternative, add an Orca **Quick Command** that runs the bundled CLI from any terminal inside the worktree:

```sh
node <plugin folder>/open.mjs
```

The graph opens as a browser tab in the focused worktree. Running the command again switches to the existing tab.

Local worktrees only. For SSH / remote Orca workspaces a message explains why nothing opens.

> Orca's plugin API is experimental. This plugin was written against Orca 1.4.x; see `CLAUDE.md` for exactly what it relies on.

## Run without Orca

```sh
pnpm install
pnpm dev -- --repo /path/to/repo     # prints a URL; hot reload
# or a production-style run:
pnpm build
node packages/server/dist/server.mjs --repo /path/to/repo --web-dir packages/web/dist
```

Requires Node.js 20+ and `git` on `PATH`.

## Keyboard

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | move selection |
| `Enter` | show / hide the detail pane |
| `/` | search; `Enter` / `Shift+Enter` or `n` / `N` step through matches |
| `c` | start / end comparison |
| `Esc` | clear search → end comparison → clear selection |

## How it works

```
Orca plugin (worker)      "Open Git Graph" → which worktree is focused? → start server if needed → open tab
        │ detached process, port/token in a private lock file
Local server (Hono)       127.0.0.1 only · random token per start · `git` via execFile · JSON API + SSE
        │ HTTP
Web UI (React, SVG, virtual scrolling)   shown in Orca's built-in browser tab; works in any browser
```

Security model: the server listens on `127.0.0.1` only, checks a random per-start token on every API call and the `Host` header (DNS-rebinding), and only serves repositories it was given (`--repo`) or that `orca worktree ps` reports. Git is always run through `execFile` with validated refs; the API is read-only apart from the explicit Fetch button. The lock file holding the token lives in your user data directory (mode 0600 / user-profile ACL).

## Development

```sh
pnpm test          # unit + integration tests (core, platform, server, orca-plugin, web)
pnpm typecheck
pnpm build         # web → server → orca-plugin/dist
pnpm test:e2e      # Playwright; run `pnpm build` first, and once: pnpm --filter @orca-git-graph/web exec playwright install chromium
node scripts/make-demo-repo.mjs /tmp/demo   # a fictional repository with ahead/behind, merges and tags
node scripts/release.mjs                    # produce the tree Orca installs from a Git URL
```

Layout: `packages/core` (parsers, lane layout, compare — no I/O), `packages/platform` (data dir, lock file, `orca` CLI), `packages/server`, `packages/web`, `packages/orca-plugin`. Plan and status: `docs/PLAN.md`. Notes on Orca's API behaviour: `CLAUDE.md`.

## License

MIT — see [LICENSE](LICENSE). The screenshots use a fictional repository. This project contains no code from other Git graph tools.
