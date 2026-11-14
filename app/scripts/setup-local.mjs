import {lstat, readFile, writeFile, chmod, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';

/** Preserve existing secrets and issuer keys; never print their contents. */
export async function setupLocal(directory) {
  const target = path.join(directory, '.dev.vars'); let source = '';
  try {
    if (!(await lstat(target)).isFile()) throw new Error('Local .dev.vars must be a regular file, not a link.');
    source = await readFile(target, 'utf8');
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  const matches = [...source.matchAll(/^[ \t]*MARKET_SIGNING_JWK[ \t]*=[ \t]*(.*)[ \t]*$/gm)];
  if (matches.length > 1) throw new Error('Keep exactly one MARKET_SIGNING_JWK entry in the ignored .dev.vars file.');
  let generated = false;
  if (matches.length) {
    let raw = matches[0][1].trim();
    if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
    else if (raw.startsWith('"') && raw.endsWith('"')) {try {raw = JSON.parse(raw);} catch { /* The validation below reports a safe message. */ }}
    try {
      const key = JSON.parse(raw);
      if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.d || !key.x || !key.y) throw new Error();
      await webcrypto.subtle.importKey('jwk', key, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
    } catch {throw new Error('Existing MARKET_SIGNING_JWK is invalid; restore its original value. Setup will not rotate it automatically.');}
  } else {
    const pair = await webcrypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    const key = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
    source = `${source.trimEnd()}\nMARKET_SIGNING_JWK='${JSON.stringify(key)}'\n`; generated = true;
  }
  if (/^\s*MARKET_DEV_MODE\s*=/m.test(source)) source = source.replace(/^\s*MARKET_DEV_MODE\s*=.*$/gm, 'MARKET_DEV_MODE=1');
  else source = `${source.trimEnd()}\nMARKET_DEV_MODE=1\n`;
  source = source.replace(/^\n+/, '');
  const temporary = `${target}.setup-${process.pid}-${webcrypto.randomUUID()}`;
  try {
    await writeFile(temporary, source, {mode: 0o600, flag: 'wx'});
    await rename(temporary, target); await chmod(target, 0o600);
  } finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
  return {generated};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error('Local setup requires Node.js 22.13 or newer.');
  const result = await setupLocal(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write(`Local demo configured; ${result.generated ? 'generated a new' : 'preserved the existing'} signing key in ignored .dev.vars. No secret values were printed.\nRun npm run db:migrate:local, then npm run dev.\n`);
}
