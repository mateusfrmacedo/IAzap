import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Legacy names are retained only for upgrades from the previous app.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('IAZAP_') && value !== undefined) {
    process.env[key.replace('IAZAP_', 'ZAPIA_')] ??= value;
  }
}
export function migrateLegacyData(): void {
  // Explicit runtime paths are isolated (tests, custom installations).
  if (process.env.ZAPIA_AUTH || process.env.ZAPIA_DATA) return;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : os.homedir();
  const old = path.join(base, process.platform === 'darwin' ? 'IAZAP' : '.iazap');
  const dest = path.join(base, process.platform === 'darwin' ? 'ZapIA' : '.zapia');
  if (fs.existsSync(old) && !fs.existsSync(dest)) fs.cpSync(old, dest, { recursive: true, errorOnExist: true });
}
