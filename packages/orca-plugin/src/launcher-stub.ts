import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The sidebar panel (panels/launcher.html) types a command into a terminal, but it cannot know where Orca installed
 * this plugin. So the worker writes a tiny stub at a fixed place under the home directory, every time it starts, that
 * forwards to the real `open.mjs`. The panel's command is `node -e "import(<home>/.orca-git-graph/launch.mjs)"`.
 *
 * The constants here must match the ones in panels/launcher.html (checked by a test).
 */
export const STUB_DIR_NAME = '.orca-git-graph';
export const STUB_FILE_NAME = 'launch.mjs';

export function stubPath(home = homedir()): string {
  return join(home, STUB_DIR_NAME, STUB_FILE_NAME);
}

export function stubSource(openMjsFile: string): string {
  return [
    '// Written by the Orca Git Graph plugin each time it starts. The sidebar panel runs this file with `node`.',
    `import(${JSON.stringify(pathToFileURL(openMjsFile).href)}).catch((e) => {`,
    "  console.error('Git Graph: could not start - ' + (e && e.message ? e.message : e));",
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}

export async function writeLauncherStub(openMjsFile: string, home = homedir()): Promise<string> {
  const file = stubPath(home);
  await mkdir(join(home, STUB_DIR_NAME), { recursive: true });
  await writeFile(file, stubSource(openMjsFile));
  return file;
}
