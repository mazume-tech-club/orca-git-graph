import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Handler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Serve the built UI; unknown paths fall back to index.html (single-page app). */
export function staticHandler(root: string): Handler {
  const base = normalize(root);
  return async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    let file = normalize(join(base, pathname === '/' ? 'index.html' : pathname));
    if (file !== base && !file.startsWith(base + sep)) return c.text('forbidden', 403);
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      if (pathname.startsWith('/assets/')) return c.text('not found', 404);
      file = join(base, 'index.html');
    }
    try {
      const body = await readFile(file);
      const ext = extname(file);
      const immutable = file.includes(`${sep}assets${sep}`);
      return c.body(body, 200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        // The page embeds a token in its URL; keep it out of Referer and framing.
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
    } catch {
      return c.text('web UI is not built (run `pnpm build`)', 404);
    }
  };
}
