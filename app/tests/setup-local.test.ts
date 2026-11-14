import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const setupScript = fileURLToPath(new URL('../scripts/setup-local.mjs', import.meta.url));
function run(directory: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', 'const {setupLocal}=await import(process.argv[1]); const result=await setupLocal(process.argv[2]); process.stdout.write(JSON.stringify(result));', new URL(`file://${setupScript}`).href, directory], {encoding: 'utf8'});
}
test('local setup generates a private ignored key once and preserves other settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fileshareica-setup-'));
  try {
    await writeFile(path.join(directory, '.dev.vars'), 'OTHER_SETTING=preserved\nMARKET_DEV_MODE=0\n');
    const first = run(directory); assert.equal(first.status, 0); assert.deepEqual(JSON.parse(first.stdout), {generated: true});
    const source = await readFile(path.join(directory, '.dev.vars'), 'utf8');
    assert.ok(source.includes('OTHER_SETTING=preserved')); assert.ok(source.includes('MARKET_DEV_MODE=1'));
    const keyLine = source.split('\n').find(line => line.startsWith('MARKET_SIGNING_JWK=')); assert.ok(keyLine);
    const second = run(directory); assert.equal(second.status, 0); assert.deepEqual(JSON.parse(second.stdout), {generated: false});
    const repeated = await readFile(path.join(directory, '.dev.vars'), 'utf8');
    assert.ok(repeated.split('\n').find(line => line.startsWith('MARKET_SIGNING_JWK=')) === keyLine);
    assert.ok(!first.stdout.includes('MARKET_SIGNING_JWK')); assert.ok(!second.stdout.includes('MARKET_SIGNING_JWK'));
    assert.equal((await stat(path.join(directory, '.dev.vars'))).mode & 0o777, 0o600);
  } finally {await rm(directory, {recursive: true, force: true});}
});
test('local setup refuses invalid existing keys and linked files without rotating or overwriting them', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fileshareica-setup-'));
  try {
    const invalid = 'MARKET_SIGNING_JWK=invalid-existing-key\n';
    await writeFile(path.join(directory, '.dev.vars'), invalid);
    assert.notEqual(run(directory).status, 0); assert.ok(await readFile(path.join(directory, '.dev.vars'), 'utf8') === invalid);
    await rm(path.join(directory, '.dev.vars'));
    await writeFile(path.join(directory, 'target'), 'PRESERVE=1\n');
    await symlink(path.join(directory, 'target'), path.join(directory, '.dev.vars'));
    assert.notEqual(run(directory).status, 0); assert.ok(await readFile(path.join(directory, 'target'), 'utf8') === 'PRESERVE=1\n');
  } finally {await rm(directory, {recursive: true, force: true});}
});
