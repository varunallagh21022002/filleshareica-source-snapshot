import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './sites-env.mjs';

// An absolute env-file path matters: Wrangler resolves worker secrets relative
// to the built config directory, which is dist/server rather than the app root.
const args = ['--import', path.join(projectRoot, 'scripts/sites-env.mjs'),
  path.join(projectRoot, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
  '--config', path.join(projectRoot, 'dist/server/wrangler.json'), '--local',
  '--persist-to', path.join(projectRoot, '.wrangler/state'), '--ip', '127.0.0.1',
  '--inspector-port', '0'];
const vars = path.join(projectRoot, '.dev.vars');
if (existsSync(vars)) args.push('--env-file', vars);
args.push(...process.argv.slice(2));
const child = spawn(process.execPath, args, {cwd: projectRoot, stdio: 'inherit'});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 0 : code ?? 1; });
