import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureToolEnvironment } from './tool-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
configureToolEnvironment(root);
const runtime = path.join(root, '.sites-runtime');
mkdirSync(runtime, { recursive: true });
const config = path.join(runtime, 'local-database.json');
writeFileSync(config, JSON.stringify({
  name: 'f8il3shar33r-local',
  compatibility_date: '2026-05-15',
  d1_databases: [{
    binding: 'DB', database_name: 'site-creator-d1',
    database_id: '00000000-0000-4000-8000-000000000000',
    migrations_dir: path.join(root, 'drizzle'),
  }],
}, null, 2));
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
  'd1', 'migrations', 'apply', 'DB', '--local', '--config', config,
  '--persist-to', path.join(root, '.wrangler/state'),
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
