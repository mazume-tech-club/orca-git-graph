import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/worker.ts
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";
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
function matchWorktree(ctx, worktrees, terminals) {
  const termIds = new Set(ctx.terminals.map((t) => t.id));
  if (termIds.size > 0) {
    const ids = new Set(terminals.filter((t) => termIds.has(t.handle) || termIds.has(t.ptyId)).map((t) => t.worktreeId));
    if (ids.size === 1) {
      const wt = worktrees.find((w) => w.id === [...ids][0]);
      if (wt) return { kind: "found", worktree: wt };
    }
  }
  const byName = worktrees.filter((w) => w.displayName === ctx.displayName && w.branch === ctx.branch);
  const loose = byName.length > 0 ? byName : worktrees.filter((w) => w.displayName === ctx.displayName);
  if (loose.length === 1) return { kind: "found", worktree: loose[0] };
  if (loose.length === 0) return { kind: "none" };
  return { kind: "ambiguous", candidates: loose };
}

// src/launcher.ts
function cacheKey(ctx) {
  if (ctx.terminals.length === 0) return null;
  return `${ctx.displayName}|${ctx.branch}|${ctx.terminals.map((t) => t.id).sort().join(",")}`;
}
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
async function openGitGraph(d) {
  const fail = makeFail(d);
  const cli = d.resolveOrcaCli();
  if (!cli) {
    return fail("no-cli", "Orca CLI \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093 / Orca CLI not found", "ORCA_CLI \u74B0\u5883\u5909\u6570\u3067 orca \u306E\u5834\u6240\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  }
  const t0 = Date.now();
  const marks = [];
  const mark = (name) => marks.push(`${name} ${Date.now() - t0}ms`);
  const server = d.ensureServer(cli).then((r) => (mark("server-ready"), r));
  server.catch(() => void 0);
  const ctx = await d.readContext();
  mark("context");
  if (!ctx) return fail("no-context", "\u30D5\u30A9\u30FC\u30AB\u30B9\u4E2D\u306E\u30EF\u30FC\u30AF\u30C4\u30EA\u30FC\u304C\u3042\u308A\u307E\u305B\u3093 / No focused worktree");
  const key = cacheKey(ctx);
  const finish = (r) => {
    mark("done");
    d.log(`open-git-graph: ${r.ok ? r.action : "failed"} \u2014 ${marks.join(", ")}`);
    return r;
  };
  const remembered = key && d.cache ? await d.cache.get(key).catch(() => null) : null;
  if (remembered) {
    mark("worktree(cached)");
    const r = await openWorktree(d, cli, remembered, { server, quietOrcaFailure: true });
    if (r.ok || r.reason !== "orca") return finish(r);
    await d.cache?.delete(key).catch(() => void 0);
    mark("cache-miss");
  }
  let worktrees;
  let terminals;
  try {
    [worktrees, terminals] = await Promise.all([d.orca.listWorktrees(cli), d.orca.listTerminals(cli)]);
  } catch (e) {
    return fail("orca", "Orca CLI \u306E\u5B9F\u884C\u306B\u5931\u6557\u3057\u307E\u3057\u305F / Orca CLI failed", errText(e));
  }
  mark("worktree");
  const match = matchWorktree(ctx, worktrees, terminals);
  if (match.kind === "none") return fail("no-match", "\u30EF\u30FC\u30AF\u30C4\u30EA\u30FC\u3092\u7279\u5B9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F / Could not identify the worktree", ctx.displayName);
  if (match.kind === "ambiguous") {
    return fail("ambiguous", "\u540C\u540D\u306E\u30EF\u30FC\u30AF\u30C4\u30EA\u30FC\u304C\u8907\u6570\u3042\u308A\u307E\u3059 / Several worktrees share this name", match.candidates.map((c) => c.path).join("\n"));
  }
  if (key) await d.cache?.set(key, match.worktree).catch(() => void 0);
  return finish(await openWorktree(d, cli, match.worktree, { server }));
}
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

// src/launcher-stub.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
import { pathToFileURL } from "node:url";
var STUB_DIR_NAME = ".orca-git-graph";
var STUB_FILE_NAME = "launch.mjs";
function stubPath(home = homedir3()) {
  return join4(home, STUB_DIR_NAME, STUB_FILE_NAME);
}
function stubSource(openMjsFile) {
  return [
    "// Written by the Orca Git Graph plugin each time it starts. The sidebar panel runs this file with `node`.",
    `import(${JSON.stringify(pathToFileURL(openMjsFile).href)}).catch((e) => {`,
    "  console.error('Git Graph: could not start - ' + (e && e.message ? e.message : e));",
    "  process.exitCode = 1;",
    "});",
    ""
  ].join("\n");
}
async function writeLauncherStub(openMjsFile, home = homedir3()) {
  const file = stubPath(home);
  await mkdir2(join4(home, STUB_DIR_NAME), { recursive: true });
  await writeFile2(file, stubSource(openMjsFile));
  return file;
}

// src/worktree-cache.ts
import { mkdir as mkdir3, readFile as readFile2, rename, writeFile as writeFile3 } from "node:fs/promises";
import { dirname, join as join5 } from "node:path";
var MAX_ENTRIES = 50;
function fileWorktreeCache(file = join5(dataDir(), "worktree-cache.json")) {
  const read = async () => {
    try {
      const v = JSON.parse(await readFile2(file, "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  };
  const write = async (data) => {
    await mkdir3(dirname(file), { recursive: true, mode: 448 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile3(tmp, JSON.stringify(data), { mode: 384 });
    await rename(tmp, file);
  };
  return {
    get: async (key) => (await read())[key] ?? null,
    set: async (key, wt) => {
      const data = await read();
      delete data[key];
      data[key] = wt;
      const keys = Object.keys(data);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete data[k];
      await write(data);
    },
    delete: async (key) => {
      const data = await read();
      if (key in data) {
        delete data[key];
        await write(data);
      }
    }
  };
}

// src/worker.ts
var here = dirname2(fileURLToPath(import.meta.url));
async function activate(ctx) {
  const openFile = join6(here, "open.mjs");
  if (existsSync2(openFile)) void writeLauncherStub(openFile).catch((e) => ctx.log(`could not write the launcher stub: ${String(e)}`));
  ctx.commands.register("open-git-graph", async () => {
    const result = await openGitGraph({
      readContext: async () => await ctx.host.call("workspace.readContext"),
      notify: async (title, body) => {
        await ctx.host.call("notifications.show", body ? { title, body: body.slice(0, 1e3) } : { title });
      },
      resolveOrcaCli: () => resolveOrcaCli(),
      ensureServer: (orcaCli) => ensureServer({
        serverEntry: join6(here, "server.mjs"),
        webDir: join6(here, "web"),
        orcaCli,
        idleMinutes: 30,
        startTimeoutMs: 15e3
      }),
      hasOpenTab: async (server, id) => {
        const n = await countUiClients(server, id);
        return n === null ? null : n > 0;
      },
      orca: realOrca,
      cache: fileWorktreeCache(),
      log: (m) => ctx.log(m)
    });
    return result;
  });
}
export {
  activate as default
};
