import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportAnalysis, exportMesh } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const input = await readJson(new URL('../examples/outline.json', import.meta.url), 65536);
for (const [scenario, values, expected] of [
  ['Concave outline with an ear-boundary blocker', ['0,0', '6,0', '6,6', '3,3', '0,6'], true],
  ['Duplicate point: complete invalid outline', ['0,0', '6,0', '6,6', '3,3', '0,0'], false],
  ['Unknown coordinate withholds geometry', ['0,0', '6,0', '6,6', 'Unknown', '0,6'], null],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-polygon-demo-'));
  try {
    const now = () => '2026-11-09T05:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now }; let result;
    for (const value of values) { const pending = await step(options); api.answer(pending.answers.find(answer => answer.status === 'pending').questionId, value); result = await step(options); }
    assert.equal(result.status, expected === null ? 'unknown' : 'complete'); assert.equal(api.calls.filter(call => call.method === 'POST').length, 5);
    if (expected === null) { assert.equal(result.analysis, null); await assert.rejects(exportAnalysis(directory, input)); }
    else { assert.equal(result.analysis.valid, expected); assert.deepEqual((await exportAnalysis(directory, input)).analysis, result.analysis); }
    if (expected === true) assert.deepEqual((await exportMesh(directory, input)).mesh, result.analysis.mesh);
    else await assert.rejects(exportMesh(directory, input));
    console.log(JSON.stringify({ scenario, status: result.status, valid: result.analysis?.valid ?? null, reasons: result.analysis?.reasons ?? null,
      triangles: result.analysis?.mesh?.triangles ?? null, certificate: result.analysis?.mesh?.certificate ?? null, sourceInspected: false }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline SDK mock demo only. No live pings, source inspection, rendering or fabrication.');
