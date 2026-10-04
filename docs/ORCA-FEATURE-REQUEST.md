# Draft: feature request / bug report for `stablyai/orca`

Not posted. Review, adjust the tone, and file it yourself (a single issue, or split into the four items below).
Everything stated here was observed on Orca 1.4.220 / Windows 11 while building
[orca-git-graph](https://github.com/mazume-tech-club/orca-git-graph).

---

## Title

Plugin API: let plugins add a button, make plugin shortcuts work in terminals, and open browser tabs without the CLI

## Summary

I built a plugin whose whole job is to open a page in a browser tab for the focused worktree. With plugin API v0 the
only ways to start it are the command palette (Mod+Shift+J) and a keybinding that does not fire while a terminal has
focus, which is where many Orca users spend their time. The result is a launch flow that is awkward enough that people
won't use the plugin. Four small additions would fix that.

## 1. A way for a plugin command to appear as a button (main request)

Today: `contributes.commands` shows up in the palette only. `contributes.panels` can add a sidebar icon, but a panel
cannot run a command, cannot reach the worker, and `PLUGIN_PANEL_ACTIONS` is limited to `workspace.readContext`,
`terminal.sendText` and `notifications.show` (CSP `default-src 'none'; connect-src 'none'`).

Proposal: e.g. `contributes.commands[].placement: ["tabBar" | "toolbar" | "newTabMenu"]` (with `icon`), so a command can
be offered next to the browser/terminal "new tab" entries. The built-in *Quick Commands* button in the tab bar shows
the UI pattern already exists; it just isn't available to plugins.

## 2. Plugin keybindings that work while a terminal has focus

Built-in definitions can set `allowInTerminal: true`, but the dispatch for plugin commands only runs when the focus
context is `app` (`Zo(pluginCommands, …)` is reached only for `h === "app"` in the global key handler). A plugin author
cannot opt in.

Proposal: `contributes.keybindings[].allowInTerminal: true` (default false), subject to the user's terminal shortcut
policy, with the usual conflict warning.

## 3. Pass the focused worktree to command handlers

`invokeCommand({ pluginKey, commandId })` sends no arguments, even for `"context": "worktree"`. The only way to learn
which worktree is focused is `workspace.readContext`, which returns `{ branch, displayName, terminals: [{ id }] }` with
no worktree id or path. I match terminal ids against `orca terminal list` and fall back to name + branch, which is
ambiguous when two worktrees share a name.

Proposal: pass `{ worktreeId, path, hostId, kind }` as the handler argument for `context: "worktree"` (or add them to
`readContext`).

## 4. Opening a browser tab from a plugin — and two problems with the CLI route

There is no host method to open a browser tab, so the worker shells out to `orca tab create`. That works, but:

- **`orca tab list|switch|show|current` take ~8.4 s whenever the worktree has no browser tab** (with a tab: 0.3–0.7 s;
  `tab create` is always ~0.5 s). Repro: close all browser tabs, run `orca tab list --worktree id:<id> --json` — it
  returns an empty list after ~8.4 s. This turns a 1-second "open" into ~9 s for the first open of a session.
- **The plugin worker is started with a minimal environment** (no `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`). `orca …`
  run from the worker then fails; it works once those variables are set. A plugin has to know to repair its
  environment before calling the CLI. (`ELECTRON_RUN_AS_NODE=1` is also inherited by children.)

Proposal: a host method such as `browser.openTab({ url, worktreeId, reuse: true })` (capability-gated) that reuses an
existing tab with the same origin, plus fixing the slow no-tab path in the CLI and passing a normal user environment to
workers.

## Why it matters

Launch friction decides whether a plugin is used at all. A visible button or a shortcut that works everywhere would make
plugins that open views (graphs, dashboards, docs) practical. Happy to test any of this against the plugin.
