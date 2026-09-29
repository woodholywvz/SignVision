import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../dist/server/index.js';

function bucket() {
  const data = new Map();
  return {
    async list() { return {objects: [...data.keys()].map(key => ({key})), truncated: false}; },
    async get(key) { return data.has(key) ? {json: async () => JSON.parse(data.get(key))} : null; },
    async put(key, value) { data.set(key, value); },
  };
}
const request = (path, data) => new Request(`https://example.com${path}`, data === undefined ? {} : {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data),
});
const sequence = Array.from({length: 12}, () => { const frame = Array(284).fill(0); frame[0] = 1; return frame; });

test('hosted Site saves landmarks and recognizes a known sequence', async () => {
  const env = {BUCKET: bucket()};
  const saved = await worker.fetch(request('/api/samples', {phrase_id: 'privet', sequence}), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).counts.privet, 1);
  const recognized = await worker.fetch(request('/api/recognize', {sequence}), env);
  assert.equal((await recognized.json()).phrase_id, 'privet');
  const config = await worker.fetch(request('/api/config'), env);
  assert.equal((await config.json()).counts.privet, 1);
});

test('hosted Site rejects sequences without hands', async () => {
  const env = {BUCKET: bucket()};
  const absent = sequence.map(() => Array(284).fill(0));
  const response = await worker.fetch(request('/api/samples', {phrase_id: 'privet', sequence: absent}), env);
  assert.equal(response.status, 422);
});
