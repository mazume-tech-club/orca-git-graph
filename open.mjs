import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli-open.ts
import { dirname, join as join4 } from "node:path";
import { fileURLToPath } from "node:url";

// ../platform/src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function dataDir() {
  const override = process.env.ORCA_GIT_GRAPH_DATA_DIR;
  if (override) return override;
  switch (process.platform) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "orca-git-graph");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "orca-git-graph");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "orca-git-graph");
  }
}

// ../platform/src/lock.ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
var API_VERSION = 1;
function lockPath() {
  return join2(dataDir(), "server.lock.json");
}
async function readLock() {
  try {
    const parsed = JSON.parse(await readFile(lockPath(), "utf8"));
    if (typeof parsed.port === "number" && typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.apiVersion === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
async function isServerAlive(lock, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health?token=${encodeURIComponent(lock.token)}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body.ok === true && body.apiVersion === API_VERSION;
  } catch {
    return false;
  }
}
async function countUiClients(server, repoId, timeoutMs = 800) {
  try {
    const q = new URLSearchParams({ repo: repoId, token: server.token });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/clients?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.count === "number" ? body.count : null;
  } catch {
    return null;
  }
}

// ../platform/src/orca.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { delimiter, join as join3 } from "node:path";
var OrcaError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "OrcaError";
  }
  code;
};
function defaultInstallPaths() {
  const home = homedir2();
  switch (process.platform) {
    case "win32":
      return [
        join3(process.env.LOCALAPPDATA ?? join3(home, "AppData", "Local"), "Programs", "orca", "resources", "bin", "orca.exe")
      ];
    case "darwin":
      return [
        "/Applications/Orca.app/Contents/Resources/bin/orca",
        join3(home, "Applications", "Orca.app", "Contents", "Resources", "bin", "orca"),
        "/usr/local/bin/orca"
      ];
    default:
      return ["/opt/Orca/resources/bin/orca", "/usr/local/bin/orca", join3(home, ".local", "bin", "orca")];
  }
}
function findOnPath() {
  const names = process.platform === "win32" ? ["orca.exe"] : ["orca"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join3(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
function resolveOrcaCli(setting) {
  const candidates = [setting, process.env.ORCA_CLI, findOnPath(), ...defaultInstallPaths()];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}
function cliEnv(base = process.env, platform = process.platform, home = homedir2()) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  if (platform === "win32") {
    env.USERPROFILE ??= home;
    env.APPDATA ??= join3(home, "AppData", "Roaming");
    env.LOCALAPPDATA ??= join3(home, "AppData", "Local");
  } else {
    env.HOME ??= home;
  }
  return env;
}
function exec(cli, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: cliEnv() };
    execFile(cli, args, opts, (err, stdout, stderr) => {
      if (stdout.trim().startsWith("{")) return resolve(stdout);
      if (err) return reject(new OrcaError(stderr.trim() || err.message, "exec_failed"));
      resolve(stdout);
    });
  });
}
async function runOrca(cli, args, timeoutMs = 15e3) {
  const out = await exec(cli, [...args, "--json"], timeoutMs);
  let env;
  try {
    env = JSON.parse(out);
  } catch {
    throw new OrcaError(`unexpected output from orca: ${out.slice(0, 200)}`, "bad_output");
  }
  if (!env.ok) throw new OrcaError(env.error?.message ?? "orca command failed", env.error?.code ?? "failed");
  return env.result;
}
async function listWorktrees(cli) {
  const r = await runOrca(cli, ["worktree", "ps"]);
  return r.worktrees.map((w) => ({
    id: w.worktreeId,
    repoId: w.repoId,
    hostId: w.hostId ?? "local",
    kind: w.workspaceKind ?? "git",
    displayName: w.displayName ?? "",
    branch: w.branch ?? "",
    path: w.path
  }));
}
async function currentWorktreeId(cli) {
  const r = await runOrca(cli, ["worktree", "current"]);
  return r.worktree.id;
}
async function listTerminals(cli) {
  const r = await runOrca(cli, ["terminal", "list"]);
  return r.terminals;
}
async function listTabs(cli, worktreeId) {
  const r = await runOrca(cli, ["tab", "list", "--worktree", `id:${worktreeId}`]);
  return r.tabs;
}
async function createTab(cli, worktreeId, url) {
  const r = await runOrca(cli, ["tab", "create", "--url", url, "--worktree", `id:${worktreeId}`]);
  return r.browserPageId;
}
async function switchTab(cli, worktreeId, pageId) {
  await runOrca(cli, ["tab", "switch", "--page", pageId, "--worktree", `id:${worktreeId}`]);
}
async function navigateTab(cli, worktreeId, pageId, url) {
  await runOrca(cli, ["goto", "--url", url, "--page", pageId, "--worktree", `id:${worktreeId}`]);
}

// src/launcher.ts
var realOrca = { listWorktrees, listTerminals, listTabs, createTab, switchTab, navigateTab };
function buildUrl(port, token, worktreeId) {
  return `http://127.0.0.1:${port}/?repo=${encodeURIComponent(worktreeId)}&token=${encodeURIComponent(token)}`;
}
function findExistingTab(tabs, worktreeId) {
  return tabs.find((t) => {
    try {
      const u = new URL(t.url);
      return u.hostname === "127.0.0.1" && u.searchParams.get("repo") === worktreeId && u.searchParams.has("token");
    } catch {
      return false;
    }
  });
}
function makeFail(d) {
  return async (reason, message, body) => {
    d.log(`open-git-graph failed (${reason}): ${message}${body ? ` \u2014 ${body.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
    await d.notify(message, body).catch(() => void 0);
    return { ok: false, reason, message };
  };
}
var errText = (e) => e instanceof Error ? e.message : String(e);
async function openWorktree(d, cli, wt, pre = {}) {
  const fail = makeFail(d);
  if (wt.hostId !== "local") {
    return fail("remote", "\u30EA\u30E2\u30FC\u30C8\u306E\u30EF\u30FC\u30AF\u30C4\u30EA\u30FC\u306F\u672A\u5BFE\u5FDC\u3067\u3059 / Remote worktrees are not supported", "Git Graph \u306F\u30ED\u30FC\u30AB\u30EB\u306E\u30EF\u30FC\u30AF\u30C4\u30EA\u30FC\u306E\u307F\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u3059\u3002");
  }
  if (wt.kind !== "git") return fail("not-git", "Git \u30EA\u30DD\u30B8\u30C8\u30EA\u3067\u306F\u3042\u308A\u307E\u305B\u3093 / Not a git repository", wt.path);
  let server;
  try {
    server = await (pre.server ?? d.ensureServer(cli));
  } catch (e) {
    return fail("server", "Git Graph \u30B5\u30FC\u30D0\u30FC\u3092\u8D77\u52D5\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F / Could not start the Git Graph server", errText(e));
  }
  const url = buildUrl(server.port, server.token, wt.id);
  try {
    const open = d.hasOpenTab ? await d.hasOpenTab(server, wt.id).catch(() => null) : null;
    if (open !== false) {
      const existing = findExistingTab(await d.orca.listTabs(cli, wt.id), wt.id);
      if (existing) {
        await d.orca.switchTab(cli, wt.id, existing.browserPageId);
        if (existing.url === url && !existing.loadError) return { ok: true, action: "switched", url };
        await d.orca.navigateTab(cli, wt.id, existing.browserPageId, url);
        return { ok: true, action: "navigated", url };
      }
    }
    await d.orca.createTab(cli, wt.id, url);
    return { ok: true, action: "created", url };
  } catch (e) {
    if (pre.quietOrcaFailure) return { ok: false, reason: "orca", message: errText(e) };
    return fail("orca", "\u30BF\u30D6\u3092\u958B\u3051\u307E\u305B\u3093\u3067\u3057\u305F / Could not open the tab", errText(e));
  }
}

// src/server-process.ts
import { spawn } from "node:child_process";
var realDeps = {
  readLock,
  isAlive: (l) => isServerAlive(l),
  spawnServer: (args, env) => {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // the worker's own environment is minimal: complete it so the server (and the orca CLI it runs) can find user data
      env: { ...cliEnv(), ...env, ...process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} }
    });
    child.unref();
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now()
};
async function ensureServer(opts, deps = realDeps) {
  const existing = await deps.readLock();
  if (existing && await deps.isAlive(existing)) return { port: existing.port, token: existing.token };
  const args = [opts.serverEntry, "--lock", "--idle-minutes", String(opts.idleMinutes), "--web-dir", opts.webDir];
  deps.spawnServer(args, opts.orcaCli ? { ORCA_CLI: opts.orcaCli } : {});
  const deadline = deps.now() + opts.startTimeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(40);
    const lock = await deps.readLock();
    if (lock && await deps.isAlive(lock)) return { port: lock.port, token: lock.token };
  }
  throw new Error("server_start_timeout");
}

// src/cli-open.ts
var here = dirname(fileURLToPath(import.meta.url));
async function main() {
  const cli = resolveOrcaCli();
  if (!cli) {
    console.error("Orca CLI not found. Set the ORCA_CLI environment variable to the path of the orca executable.");
    return 1;
  }
  const id = await currentWorktreeId(cli).catch(() => null);
  if (!id) {
    console.error("This directory is not inside an Orca worktree.");
    return 1;
  }
  const wt = (await listWorktrees(cli)).find((w) => w.id === id);
  if (!wt) {
    console.error(`Orca does not list the worktree ${id}.`);
    return 1;
  }
  const result = await openWorktree(
    {
      readContext: async () => null,
      // there is no desktop notification here: errors go to the terminal
      notify: async (title, body) => {
        console.error(body ? `${title}
${body}` : title);
      },
      resolveOrcaCli: () => cli,
      ensureServer: (orcaCli) => ensureServer({ serverEntry: join4(here, "server.mjs"), webDir: join4(here, "web"), orcaCli, idleMinutes: 30, startTimeoutMs: 15e3 }),
      hasOpenTab: async (server, worktreeId) => {
        const n = await countUiClients(server, worktreeId);
        return n === null ? null : n > 0;
      },
      orca: realOrca,
      log: () => void 0
    },
    cli,
    wt
  );
  if (result.ok) console.log(`Git Graph: ${result.action} (${wt.displayName})`);
  return result.ok ? 0 : 1;
}
main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
);
