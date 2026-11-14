import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearPreviewShell} from '../lib/client/preview-cache';

test('development removes only this app worker and named shell caches', async () => {
  const removedWorkers: string[] = []; const removedCaches: string[] = [];
  const origin = 'http://127.0.0.1:5180';
  const registration = (scope: string, scriptURL: string) => ({scope, active: {scriptURL}, unregister: async () => {removedWorkers.push(scriptURL); return true;}});
  const workers = {getRegistrations: async () => [
    registration(`${origin}/`, `${origin}/sw.js`),
    registration(`${origin}/other/`, `${origin}/other/sw.js`),
    registration(`${origin}/`, `${origin}/unrelated-worker.js`),
    registration('https://another.example/', 'https://another.example/sw.js'),
  ]};
  const caches = {keys: async () => ['fileshare-shell-v1', 'fil3shareica-shell-v3', 'unrelated-assets', 'user-downloads'], delete: async (name: string) => {removedCaches.push(name); return true;}};
  await clearPreviewShell(origin, workers, caches);
  assert.deepEqual(removedWorkers, [`${origin}/sw.js`]);
  assert.deepEqual(removedCaches, ['fileshare-shell-v1', 'fil3shareica-shell-v3']);
});

test('waiting/installing app workers are removed without a page reload or any database access', async () => {
  let removed = 0;
  await clearPreviewShell('https://preview.example', {getRegistrations: async () => [{scope: 'https://preview.example/', waiting: {scriptURL: 'https://preview.example/sw.js'}, unregister: async () => {removed++; return true;}}]});
  assert.equal(removed, 1);
});
