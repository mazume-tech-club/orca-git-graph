import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests start the plugin worker, which writes ~/.orca-git-graph/launch.mjs. Never let a test touch the real home
// directory (it once overwrote the user's launcher stub with a path into src/).
const fakeHome = mkdtempSync(join(tmpdir(), 'ogg-test-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
