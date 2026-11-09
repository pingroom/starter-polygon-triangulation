import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAnalysis, exportMesh } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parsePoint, triangulate, polygonAnalysis, validatePoint, MAX_COORDINATE, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/outline.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-polygon-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later vertex reports; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '0,1'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a vertex report', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '0,1'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across vertex reports', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '0,1'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '0,1');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '0,1'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '0,1'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '0,1');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '0,1'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

const manifest = n => ({ outlineId: 'fixture', title: 'Practice outline', coordinateMeaning: 'Corners relative to the sketch origin.', unit: 'mm', vertices: Array.from({ length: n }, (_, i) => ({ id: 'v' + i, label: 'Corner ' + i })) });
const coordinatesFor = (input, pairs) => Object.fromEntries(input.vertices.map((vertex, i) => [vertex.id, { x: pairs[i][0], y: pairs[i][1] }]));
const crossNumber = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const fanArea = points => points.slice(1, -1).reduce((sum, point, i) => sum + crossNumber(points[0], point, points[i + 2]), 0);
const onEdge = (a, b, p) => crossNumber(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
function rayInside(points, point) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function intersectionArea(subject, clip) {
  let output = subject.map(point => ({ ...point }));
  for (let edge = 0; edge < 3; edge++) {
    const a = clip[edge], b = clip[(edge + 1) % 3], input = output; output = [];
    for (let i = 0; i < input.length; i++) {
      const previous = input[(i + input.length - 1) % input.length], current = input[i], dp = crossNumber(a, b, previous), dc = crossNumber(a, b, current);
      if ((dp >= 0) !== (dc >= 0)) { const t = dp / (dp - dc); output.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) }); }
      if (dc >= 0) output.push(current);
    }
  }
  return output.length < 3 ? 0 : Math.abs(fanArea(output)) / 2;
}
function checkMesh(input, coordinates, analysis) {
  assert.equal(analysis.valid, true); const triangles = analysis.mesh.triangles, points = input.vertices.map(vertex => coordinates[vertex.id]);
  assert.equal(triangles.length, points.length - 2); assert.equal(analysis.absoluteTwiceArea, String(Math.abs(fanArea(points))));
  assert.equal(triangles.reduce((sum, triangle) => sum + BigInt(triangle.twiceArea), 0n).toString(), analysis.absoluteTwiceArea);
  const key = (a, b) => JSON.stringify([a, b].sort()), edges = new Map(), boundary = new Set(input.vertices.map((vertex, i) => key(vertex.id, input.vertices[(i + 1) % input.vertices.length].id)));
  for (const triangle of triangles) {
    const vertices = triangle.vertexIds.map(id => coordinates[id]); assert.equal(crossNumber(...vertices), Number(triangle.twiceArea)); assert.ok(crossNumber(...vertices) > 0);
    assert.deepEqual(triangle.vertices, triangle.vertexIds.map(id => ({ id, ...coordinates[id] })));
    for (let i = 0; i < 3; i++) { const a = triangle.vertexIds[i], b = triangle.vertexIds[(i + 1) % 3], k = key(a, b); if (!edges.has(k)) edges.set(k, []); edges.get(k).push([a, b]); }
  }
  for (const edge of boundary) assert.equal(edges.get(edge)?.length, 1);
  for (const [edge, directions] of edges) if (!boundary.has(edge)) { assert.equal(directions.length, 2); assert.deepEqual(directions[0], directions[1].toReversed()); }
  assert.equal(edges.size - boundary.size, points.length - 3);
  for (let i = 0; i < triangles.length; i++) for (let j = i + 1; j < triangles.length; j++) assert.ok(intersectionArea(triangles[i].vertices, triangles[j].vertices) < 1e-8, 'Triangle interiors overlap');
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  for (let x = minX - 1; x <= maxX; x++) for (let y = minY - 1; y <= maxY; y++) {
    const point = { x: x + 0.25, y: y + 0.375 };
    if (triangles.some(triangle => triangle.vertices.some((a, i) => onEdge(a, triangle.vertices[(i + 1) % 3], point)))) continue;
    const count = triangles.filter(triangle => triangle.vertices.every((a, i) => crossNumber(a, triangle.vertices[(i + 1) % 3], point) > 0)).length;
    assert.equal(count, rayInside(points, point) ? 1 : 0, 'Mesh coverage differs from polygon');
  }
}

test('330 transformed outlines across both windings and every cyclic start have exact areas, edge counts and nonoverlapping coverage', () => {
  const shapes = [[[0, 0], [6, 0], [1, 5]], [[0, 0], [4, 0], [4, 3], [0, 3]], [[0, 0], [6, 0], [6, 6], [3, 3], [0, 6]],
    [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]], [[0, 0], [8, 0], [8, 6], [5, 6], [4, 3], [2, 6], [0, 6]],
    [[0, 0], [8, 0], [8, 8], [6, 8], [6, 2], [2, 2], [2, 8], [0, 8]]];
  const transforms = [(x, y) => [x, y], (x, y) => [2 * x + 3, 2 * y - 2], (x, y) => [0 - x, y], (x, y) => [y, 0 - x], (x, y) => [x + y, 2 * y]]; let checked = 0;
  for (const shape of shapes) for (const transform of transforms) for (const reversed of [false, true]) for (let start = 0; start < shape.length; start++) {
    const input = manifest(shape.length), coordinates = coordinatesFor(input, shape.map(([x, y]) => transform(x, y)));
    if (reversed) input.vertices.reverse(); input.vertices = [...input.vertices.slice(start), ...input.vertices.slice(0, start)];
    const result = triangulate(input, coordinates); checkMesh(input, coordinates, result); assert.deepEqual(triangulate(input, coordinates), result); checked++;
  }
  assert.equal(checked, 330);
});

function permutations(values) { return values.length ? values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest])) : [[]]; }
test('all 144 convex quadrilateral and pentagon orderings distinguish simple cycles from crossings', () => {
  let checked = 0;
  for (const shape of [[[0, 0], [4, 0], [4, 4], [0, 4]], [[0, 0], [4, 0], [6, 3], [3, 6], [0, 4]]]) {
    const n = shape.length, base = manifest(n), coordinates = coordinatesFor(base, shape);
    for (const order of permutations(Array.from({ length: n }, (_, i) => i))) {
      const differences = order.map((index, i) => (order[(i + 1) % n] - index + n) % n), simpleCycle = differences.every(d => d === 1) || differences.every(d => d === n - 1);
      const input = { ...base, vertices: order.map(i => base.vertices[i]) }, result = triangulate(input, coordinates);
      assert.equal(result.valid, simpleCycle); if (simpleCycle) checkMesh(input, coordinates, result); else assert.equal(result.mesh, null); checked++;
    }
  }
  assert.equal(checked, 144);
});

test('inclusive ear boundaries block premature clipping; eligible ears use smallest original index', () => {
  const input = simple(), coordinates = coordinatesFor(input, [[0, 0], [6, 0], [6, 6], [3, 3], [0, 6]]), result = triangulate(input, coordinates);
  assert.deepEqual(result.mesh.triangles.map(triangle => triangle.vertexIds), [['b', 'c', 'd'], ['a', 'b', 'd'], ['a', 'd', 'e']]);
  const square = manifest(4), mesh = triangulate(square, coordinatesFor(square, [[0, 0], [4, 0], [4, 4], [0, 4]])).mesh;
  assert.deepEqual(mesh.triangles[0].originalIndices, [3, 0, 1]);
});

test('crossing, touching, overlapping, duplicate, zero-area and collinear outlines retain explicit reasons and no mesh', () => {
  for (const [shape, reason] of [
    [[[0, 0], [4, 4], [0, 4], [4, 0]], 'nonadjacent_edges_intersect'],
    [[[0, 0], [6, 0], [6, 6], [3, 0], [0, 6]], 'nonadjacent_edges_intersect'],
    [[[0, 0], [6, 0], [6, 6], [2, 0], [4, 0], [0, 6]], 'nonadjacent_edges_intersect'],
    [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], 'duplicate_points'],
    [[[0, 0], [2, 0], [4, 0]], 'zero_area'],
    [[[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]], 'collinear_corner'],
    [[[0, 0], [4, 0], [2, 0], [2, 3], [0, 3]], 'collinear_corner'],
  ]) { const input = manifest(shape.length), result = triangulate(input, coordinatesFor(input, shape)); assert.equal(result.valid, false); assert.equal(result.mesh, null); assert.ok(result.reasons.some(item => item.code === reason)); }
});

test('one-half square unit and largest coordinate bounds retain exact twice-area strings', () => {
  const tiny = manifest(3), triangle = triangulate(tiny, coordinatesFor(tiny, [[0, 0], [1, 0], [0, 1]]));
  assert.equal(triangle.mesh.certificate.polygonTwiceArea, '1'); assert.equal(triangle.mesh.triangles[0].twiceArea, '1');
  const large = manifest(4), coordinates = coordinatesFor(large, [[-10000, -10000], [10000, -10000], [10000, 10000], [-10000, 10000]]);
  const result = triangulate(large, coordinates); assert.equal(result.absoluteTwiceArea, '800000000'); assert.equal(result.mesh.certificate.areaConserved, true); assert.equal(MAX_COORDINATE, 10000);
  large.vertices.reverse(); assert.equal(triangulate(large, coordinates).signedTwiceArea, '-800000000');
});

test('strict normalized coordinate grammar rejects signs, rounding, extra values and out-of-range coordinates', () => {
  assert.deepEqual(parsePoint('-10000,10000'), { kind: 'point', point: { x: -10000, y: 10000 } }); assert.deepEqual(parsePoint('Unknown'), { kind: 'unknown', point: null });
  assert.deepEqual(parsePoint('0,0').point, { x: 0, y: 0 });
  for (const value of ['', 'unknown', 'Unknown\n', ' 0,0', '0,0 ', '0, 0', '+0,0', '-0,0', '00,0', '-01,0', '0,01', '0,1.0', '0,1e2', '0,Infinity', '0,0,1', '1', '-10001,0', '0,10001', '0,0\n', '0,１', '0,1 mm']) assert.throws(() => parsePoint(value), value);
  for (const point of [{ x: -0, y: 0 }, { x: 0, y: NaN }, { x: '0', y: 0 }, { x: 0, y: 0, extra: true }]) assert.throws(() => validatePoint(point));
});

test('Unknown or missing at every vertex withholds geometry, and exact ordered answers are required', () => {
  const input = manifest(3), known = [{ vertexId: 'v0', text: '0,0' }, { vertexId: 'v1', text: '3,0' }, { vertexId: 'v2', text: '0,3' }];
  for (const value of [null, 'Unknown']) for (let i = 0; i < 3; i++) { const answers = structuredClone(known); answers[i].text = value; assert.equal(polygonAnalysis(input, answers).analysis, null); }
  for (const answers of [known.toReversed(), Array(3), [known[0]], [...known, known[0]], [{ 'vertexId,text': 'merged' }, ...known.slice(1)]]) assert.throws(() => polygonAnalysis(input, answers));
  assert.throws(() => triangulate(input, { 'v0,v1,v2': { x: 0, y: 0 } }));
});

test('manifest limits, extra rings, duplicate IDs, sparse arrays and merged keys fail before API calls', async t => {
  for (const mutate of [i => { i.vertices = i.vertices.slice(0, 2); }, i => { i.vertices = Array(3); }, i => { i.vertices = manifest(9).vertices; }, i => { i.vertices[1].id = i.vertices[0].id; },
    i => { i.vertices[0].id = 'constructor'; }, i => { i.vertices[0].extra = true; }, i => { i.holes = []; }, i => { i['outlineId,title'] = 'merged'; delete i.outlineId; delete i.title; }]) {
    const input = simple(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0);
  }
});

test('Unicode bounds and true-end identifier, credential and room grammars fail before network', async t => {
  for (const mutate of [i => { i.outlineId += '\n'; }, i => { i.vertices[0].id += '\n'; }, i => { i.vertices[0].id = 'a'.repeat(17); }, i => { i.title = 'a'.repeat(41); },
    i => { i.coordinateMeaning = 'a'.repeat(101); }, i => { i.unit = 'a'.repeat(13); }, i => { i.vertices[0].label = 'a'.repeat(31); }, i => { i.unit = ''; }, i => { i.title = '\ud800'; }, i => { i.coordinateMeaning = 'bad\u202Etext'; }]) {
    const input = simple(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0);
  }
  assert.equal(isId(id(1) + '\n'), false); assert.equal(ROOM.test(ROOM_CODE + '\n'), false); assert.equal(TOKEN.test('token\n'), false); assert.throws(() => validateConnection({ token: 'token', room: ROOM_CODE + '\n' }));
  const config = structuredClone(CONFIG); config.participant.id += '\n'; assert.throws(() => requestFor(simple(), config, 'a', id(1)));
});

test('eight largest metadata prompts carry coordinate meaning and axes within 500 units', async t => {
  const input = { ...manifest(8), outlineId: 'a'.repeat(40), title: '🟦'.repeat(20), coordinateMeaning: '🟩'.repeat(50), unit: 'u'.repeat(12) };
  input.vertices = input.vertices.map((vertex, i) => ({ id: 'v'.repeat(15) + i, label: '🟨'.repeat(15) }));
  for (const vertex of input.vertices) { const request = requestFor(input, CONFIG, vertex.id, id(1)); assert.equal(request.prompt.length, 461); assert.ok(request.context.length <= 40);
    for (const text of [vertex.id, vertex.label, input.coordinateMeaning, input.unit, 'planar x right, y up']) assert.ok(request.prompt.includes(text)); assert.equal(request.options, undefined); }
  const s = await setup(t, input), result = await decide(s, ['0,0', '8,0', '8,8', '6,8', '6,2', '2,2', '2,8', '0,8']); assert.equal(result.analysis.valid, true); await s.run(); assert.equal(sends(s.api), 8);
});

test('manifest and coordinate hashes bind distinct sources; saved order, labels, units and policy are immutable', async t => {
  const s = await setup(t), result = await decide(s, ['0,0', '6,0', '6,6', '3,3', '0,6']); assert.equal(result.manifestHash, hash(validateInput(simple()))); assert.equal(result.sourceHash, result.analysis.mesh.sourceHash);
  const coordinates = coordinatesFor(simple(), [[0, 0], [6, 0], [6, 6], [3, 3], [0, 6]]), changed = structuredClone(coordinates); changed.b.x++;
  assert.notEqual(triangulate(simple(), coordinates).sourceHash, triangulate(simple(), changed).sourceHash);
  for (const mutate of [i => { i.vertices.reverse(); }, i => { i.vertices[0].label = 'Another corner'; }, i => { i.unit = 'cm'; }]) { const input = simple(); mutate(input); const before = s.api.calls.length; await assert.rejects(s.run({ input })); assert.equal(s.api.calls.length, before); }
  const saved = await s.saved(); saved.attempts[0].request.data.policy_hash = hash('other'); await atomicJson(s.directory, 'state.json', saved); await assert.rejects(s.run());
});

test('complete valid geometry exports attributed mesh; complete invalid geometry exports reasons only', async t => {
  for (const valid of [true, false]) {
    const s = await setup(t), result = await decide(s, ['0,0', '6,0', '6,6', '3,3', valid ? '0,6' : '0,0']);
    const exported = await exportAnalysis(s.directory, s.options.input); assert.equal(exported.analysis.valid, valid); assert.deepEqual(exported.answers, result.answers); assert.equal(exported.sourceInspected, false);
    assert.ok(exported.answers.every(answer => answer.responderId === CONFIG.participant.id && answer.askerId === ASKER));
    if (valid) { const mesh = await exportMesh(s.directory, s.options.input); assert.deepEqual(mesh.mesh, result.analysis.mesh); assert.equal((await stat(join(s.directory, 'mesh.json'))).mode & 0o777, 0o600); }
    else { assert.equal(exported.analysis.mesh, null); await assert.rejects(exportMesh(s.directory, s.options.input)); }
  }
});

test('Unknown or invalid evidence blocks both exports; locks and tampered saved points preserve earlier artifacts', async t => {
  for (const value of ['Unknown', '0,10001']) { const s = await setup(t); await decide(s, ['0,0', '6,0', '6,6', value, '0,6']);
    await assert.rejects(exportAnalysis(s.directory, s.options.input)); await assert.rejects(exportMesh(s.directory, s.options.input)); await s.run(); assert.equal(sends(s.api), 5); }
  const s = await setup(t); await decide(s, ['0,0', '6,0', '6,6', '3,3', '0,6']); await exportMesh(s.directory, s.options.input);
  const before = await readFile(join(s.directory, 'mesh.json'), 'utf8'), release = await acquireLock(s.directory); await assert.rejects(exportMesh(s.directory, s.options.input), /lock exists/); await release();
  const saved = await s.saved(); saved.attempts[0].observation.answer.point.x++; await atomicJson(s.directory, 'state.json', saved); await assert.rejects(exportMesh(s.directory, s.options.input));
  assert.equal(await readFile(join(s.directory, 'mesh.json'), 'utf8'), before);
});

test('monotonic observation timestamps cannot regress across pending reads', async t => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:01:00.000Z'; await s.run();
  const before = await readFile(join(s.directory, 'state.json'), 'utf8'); s.clock.value = '2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(), /regressed/); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
});
