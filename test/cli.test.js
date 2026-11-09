import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Offline command attempted a request');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://api.pingroom.io');
  assert.equal(init.redirect, 'manual');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    assert.equal(body.options, undefined);
    assert.deepEqual(body.text_input, {placeholder:'x,y or Unknown',max_length:60});
    assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, results: null, options: [],
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER !== undefined) {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value:null, label:null, text:process.env.PROBE_ANSWER, responder:{id:q.target_user_id}, answered_at:q.resolved_at };
    } else if (process.env.PROBE_CANCEL === 'yes') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'polygon-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await cp(join(source, 'examples/outline.json'), join(directory, 'outline.json'));
  return directory;
}
function run(directory, command = ['run'], extra = {}) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json') };
  for (const key of ['NODE_OPTIONS','PROBE_ANSWER','PROBE_CANCEL','PROBE_LOST','PROBE_OFFLINE']) delete env[key];
  Object.assign(env,extra);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...command], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function collect(directory, values) {
  let answer;
  for(const [i,value] of values.entries()) {
    const pending=await run(directory);assert.equal(pending.code,3,pending.stderr);assert.equal(JSON.parse(pending.stdout).status,'pending');
    answer=await run(directory,['run'],{PROBE_ANSWER:value});
    if(i<values.length-1)assert.ok([2,3].includes(answer.code),answer.stderr);
  }
  return answer;
}

const posted = async directory => Object.keys(JSON.parse(await readFile(join(directory, 'questions.json'), 'utf8'))).length;

const validCoordinates = ['0,0', '6,0', '6,6', '3,3', '0,6'];
test('CLI previews ordered metadata and exports a valid attributed mesh from another working directory', async t => {
  const directory = await fixture(t), original = await readFile(join(directory, 'outline.json'), 'utf8');
  const preview = await run(directory, ['preview'], { PROBE_OFFLINE: 'yes' }); assert.equal(preview.code, 0, preview.stderr); assert.deepEqual(JSON.parse(preview.stdout).vertices.map(vertex => vertex.id), ['a', 'b', 'c', 'd', 'e']);
  const finished = await collect(directory, validCoordinates); assert.equal(finished.code, 0, finished.stderr);
  const result = JSON.parse(finished.stdout); assert.equal(result.analysis.valid, true); assert.equal(result.analysis.mesh.triangles.length, 3);
  for (const command of ['status', 'report', 'export', 'export-mesh']) {
    const output = await run(directory, [command], { PROBE_OFFLINE: 'yes', PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined }); assert.equal(output.code, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).sourceHash, result.sourceHash);
  }
  const artifact = JSON.parse(await readFile(join(directory, '.polygon/mesh.json'), 'utf8'));
  assert.deepEqual(artifact.mesh, result.analysis.mesh); assert.deepEqual(artifact.answers, result.answers); assert.equal(artifact.sourceInspected, false);
  assert.equal((await stat(join(directory, '.polygon/mesh.json'))).mode & 0o777, 0o600); assert.equal(await posted(directory), 5);
  assert.equal(await readFile(join(directory, 'outline.json'), 'utf8'), original); assert.equal((await run(directory, ['run'], { PROBE_OFFLINE: 'yes' })).code, 0);
});

test('CLI complete invalid geometry exports reasons but cannot export a mesh', async t => {
  const directory = await fixture(t), finished = await collect(directory, ['0,0', '6,0', '6,6', '3,3', '0,0']); assert.equal(finished.code, 0, finished.stderr);
  const result = JSON.parse(finished.stdout); assert.equal(result.status, 'complete'); assert.equal(result.analysis.valid, false); assert.equal(result.analysis.mesh, null);
  assert.ok(result.analysis.reasons.some(reason => reason.code === 'duplicate_points'));
  assert.equal((await run(directory, ['export'], { PROBE_OFFLINE: 'yes' })).code, 0);
  assert.equal((await run(directory, ['export-mesh'], { PROBE_OFFLINE: 'yes' })).code, 1); await assert.rejects(readFile(join(directory, '.polygon/mesh.json')), { code: 'ENOENT' });
});

test('CLI final Unknown exits 2, keeps source hash null and refuses both geometry exports', async t => {
  const directory = await fixture(t); assert.equal((await run(directory, ['export'], { PROBE_OFFLINE: 'yes' })).code, 1);
  const finished = await collect(directory, ['0,0', '6,0', '6,6', '3,3', 'Unknown']); assert.equal(finished.code, 2, finished.stderr);
  const result = JSON.parse(finished.stdout); assert.equal(result.status, 'unknown'); assert.equal(result.analysis, null); assert.equal(result.sourceHash, null); assert.match(result.manifestHash, /^[a-f0-9]{64}$/);
  for (const command of ['export', 'export-mesh']) assert.equal((await run(directory, [command], { PROBE_OFFLINE: 'yes' })).code, 1);
  assert.equal((await run(directory, ['run'], { PROBE_OFFLINE: 'yes' })).code, 2); assert.equal(await posted(directory), 5);
  assert.equal((await run(directory, ['status'], { PROBE_OFFLINE: 'yes' })).code, 0);
});

test('CLI invalid coordinates and cancellation remain unresolved evidence after later vertices are collected', async t => {
  const directory = await fixture(t), finished = await collect(directory, ['-0,0', '6,0', '6,6', '3,3', '0,6']); assert.equal(finished.code, 2, finished.stderr);
  assert.equal(JSON.parse(finished.stdout).analysis, null); assert.equal((await run(directory, ['export'], { PROBE_OFFLINE: 'yes' })).code, 1); assert.equal(await posted(directory), 5);
  const cancelled = await fixture(t); assert.equal((await run(cancelled)).code, 3); assert.equal((await run(cancelled, ['run'], { PROBE_CANCEL: 'yes' })).code, 2);
  const remaining = await collect(cancelled, validCoordinates.slice(1)); assert.equal(remaining.code, 2); assert.equal(JSON.parse(remaining.stdout).status, 'incomplete');
  assert.equal((await run(cancelled, ['export-mesh'], { PROBE_OFFLINE: 'yes' })).code, 1);
});

test('CLI exact-ID recovery attaches the original uncertain coordinate Question without resend', async t => {
  const directory = await fixture(t); assert.equal((await run(directory, ['run'], { PROBE_LOST: 'yes' })).code, 4);
  assert.equal((await run(directory, ['run'], { PROBE_OFFLINE: 'yes' })).code, 4);
  const found = await run(directory, ['find']); assert.equal(found.code, 4); const qid = JSON.parse(found.stdout).candidates[0].id;
  const recovered = await run(directory, ['recover', qid], { PROBE_ANSWER: '0,0' }); assert.equal(recovered.code, 3, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).answers[0].questionId, qid); assert.equal(await posted(directory), 1);
  const finished = await collect(directory, validCoordinates.slice(1)); assert.equal(finished.code, 0); assert.equal(await posted(directory), 5);
});

test('CLI credentials require complete pairs and support a complete dotenv connection', async t => {
  const directory = await fixture(t); await writeFile(join(directory, '.env'), 'PINGROOM_TOKEN=file-fixture\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = await run(directory, ['run'], { PINGROOM_TOKEN: 'shell-fixture', PINGROOM_ROOM: undefined, PROBE_OFFLINE: 'yes' }); assert.equal(partial.code, 1); assert.match(partial.stderr, /complete PINGROOM_TOKEN/);
  await assert.rejects(readFile(join(directory, 'questions.json')), { code: 'ENOENT' });
  assert.equal((await run(directory, ['run'], { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined })).code, 3);
});

test('CLI rejects order drift, holes, malformed recovery IDs and arbitrary paths without changing an earlier mesh', async t => {
  const directory = await fixture(t); await collect(directory, validCoordinates); await run(directory, ['export-mesh'], { PROBE_OFFLINE: 'yes' });
  const original = await readFile(join(directory, '.polygon/mesh.json'), 'utf8'), input = JSON.parse(await readFile(join(directory, 'outline.json'), 'utf8'));
  input.vertices.reverse(); await writeFile(join(directory, 'outline.json'), JSON.stringify(input));
  for (const command of ['run', 'export', 'export-mesh']) assert.equal((await run(directory, [command], { PROBE_OFFLINE: 'yes' })).code, 1);
  assert.equal(await readFile(join(directory, '.polygon/mesh.json'), 'utf8'), original); assert.equal(await posted(directory), 5);
  const invalid = await fixture(t), bad = JSON.parse(await readFile(join(invalid, 'outline.json'), 'utf8')); bad.holes = [];
  await writeFile(join(invalid, 'outline.json'), JSON.stringify(bad)); assert.equal((await run(invalid, ['run'], { PROBE_OFFLINE: 'yes' })).code, 1);
  await assert.rejects(readFile(join(invalid, 'questions.json')), { code: 'ENOENT' });
  assert.equal((await run(invalid, ['export', '/etc/passwd'], { PROBE_OFFLINE: 'yes' })).code, 1);
  assert.equal((await run(invalid, ['recover', '01990000-0000-7000-8000-000000000001\n'], { PROBE_OFFLINE: 'yes' })).code, 1);
});
