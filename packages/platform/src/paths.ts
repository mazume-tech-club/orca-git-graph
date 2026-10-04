import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-user data directory (lock file, logs). Not shared with other OS users by default. */
export function dataDir(): string {
  const override = process.env.ORCA_GIT_GRAPH_DATA_DIR;
  if (override) return override;
  switch (process.platform) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'orca-git-graph');
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'orca-git-graph');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'orca-git-graph');
  }
}
