import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const MAX_COORDINATE = 10000;
export const POLICY = Object.freeze({ outline: 'single-simple-planar-ring-no-adjacent-collinearity-v1', triangulation: 'ccw-ear-clipping-smallest-original-index-v1', containment: 'inclusive-triangle-boundary-blocks-ear-v1', arithmetic: 'exact-integer-bigint-twice-area-v1' });
export const POLICY_HASH = hash(POLICY);
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_COORDINATE && !Object.is(value, -0);
const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const promptFor = (input, vertex, index) => `${input.title}\nOutline: ${input.outlineId}\nMeaning: ${input.coordinateMeaning}\nVertex ${index + 1}/${input.vertices.length} ${vertex.id}: ${vertex.label}\nUnit: ${input.unit}; planar x right, y up.\nReport x,y integers -10000 to 10000, or Unknown. Use the declared vertex order and origin. No +, spaces or leading zeros. Do not estimate unknown coordinates.`;

export function validateInput(input) {
  if (!keys(input, ['outlineId', 'title', 'coordinateMeaning', 'unit', 'vertices']) || !word(input.outlineId)
    || !line(input.title, 40) || !line(input.coordinateMeaning, 100) || !line(input.unit, 12)
    || !Array.isArray(input.vertices) || input.vertices.length < 3 || input.vertices.length > 8) throw new Error('Supply an outline ID, title, coordinate meaning, unit and an ordered list of three to eight vertices.');
  const ids = new Set();
  const vertices = Array.from(input.vertices, (vertex, index) => {
    if (!keys(vertex, ['id', 'label']) || !safeId(vertex.id) || ids.has(vertex.id) || !line(vertex.label, 30)
      || promptFor(input, vertex, index).length > 500) throw new Error('Vertices require unique safe IDs and labels up to 30 UTF-16 units; full prompts must fit 500 units.');
    ids.add(vertex.id); return structuredClone(vertex);
  });
  return { outlineId: input.outlineId, title: input.title, coordinateMeaning: input.coordinateMeaning, unit: input.unit, vertices };
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact editor UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => validateInput(input).vertices;
export function validatePoint(point) {
  if (!keys(point, ['x', 'y']) || !integer(point.x) || !integer(point.y)) throw new Error('Coordinates must be integers -10000 to 10000.');
  return { x: point.x, y: point.y };
}
export function parsePoint(text) {
  if (text === 'Unknown') return { kind: 'unknown', point: null };
  if (typeof text !== 'string' || !/^(?:0|-?[1-9][0-9]{0,4}),(?:0|-?[1-9][0-9]{0,4})(?![\s\S])/.test(text)) throw new Error('Reply x,y using signed canonical integers, or exactly Unknown.');
  const [x, y] = text.split(',').map(Number);
  return { kind: 'point', point: validatePoint({ x, y }) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), index = input.vertices.findIndex(vertex => vertex.id === taskId); validateConfig(config);
  if (index < 0 || !isId(attemptId)) throw new Error('Invalid vertex or attempt.');
  const key = `polygon-${attemptId}`;
  return { prompt: promptFor(input, input.vertices[index], index), context: `To ${config.participant.id}`, text_input: { placeholder: 'x,y or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), vertex_hash: hash(input.vertices[index]), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

const cross = (a, b, c) => (BigInt(b.x) - BigInt(a.x)) * (BigInt(c.y) - BigInt(a.y)) - (BigInt(b.y) - BigInt(a.y)) * (BigInt(c.x) - BigInt(a.x));
const between = (value, a, b) => value >= Math.min(a, b) && value <= Math.max(a, b);
const onSegment = (a, b, p) => cross(a, b, p) === 0n && between(p.x, a.x, b.x) && between(p.y, a.y, b.y);
const opposite = (a, b) => a < 0n && b > 0n || a > 0n && b < 0n;
function intersects(a, b, c, d) {
  return opposite(cross(a, b, c), cross(a, b, d)) && opposite(cross(c, d, a), cross(c, d, b))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
const insideTriangle = (a, b, c, p) => cross(a, b, p) >= 0n && cross(b, c, p) >= 0n && cross(c, a, p) >= 0n;
const signedArea = points => points.reduce((sum, p, index) => { const q = points[(index + 1) % points.length]; return sum + BigInt(p.x) * BigInt(q.y) - BigInt(p.y) * BigInt(q.x); }, 0n);
const edgeKey = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;

function certificate(points, ccw, triangles, twiceArea) {
  const boundary = new Map(ccw.map((index, position) => { const next = ccw[(position + 1) % ccw.length]; return [edgeKey(index, next), [index, next]]; }));
  const edges = new Map(), used = new Set(); let sum = 0n;
  for (const triangle of triangles) {
    const indices = triangle.originalIndices; sum += BigInt(triangle.twiceArea);
    for (let i = 0; i < 3; i++) { const a = indices[i], b = indices[(i + 1) % 3]; used.add(a); const key = edgeKey(a, b); if (!edges.has(key)) edges.set(key, []); edges.get(key).push([a, b]); }
  }
  const internalEdges = []; let boundaryMatched = true, internalMatched = true;
  for (const [key, expected] of boundary) { const directions = edges.get(key) ?? []; if (directions.length !== 1 || directions[0][0] !== expected[0] || directions[0][1] !== expected[1]) boundaryMatched = false; }
  for (const [key, directions] of edges) if (!boundary.has(key)) {
    if (directions.length !== 2 || directions[0][0] !== directions[1][1] || directions[0][1] !== directions[1][0]) internalMatched = false;
    internalEdges.push(key.split(':').map(Number));
  }
  internalEdges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result = { expectedTriangleCount: points.length - 2, triangleCount: triangles.length, polygonTwiceArea: twiceArea.toString(), trianglesTwiceArea: sum.toString(),
    areaConserved: sum === twiceArea, trianglesCounterclockwise: triangles.every(triangle => BigInt(triangle.twiceArea) > 0n), allVerticesUsed: used.size === points.length,
    boundaryEdgesMatched: boundaryMatched, internalEdgesPaired: internalMatched, boundaryEdgeCount: boundary.size, internalEdgeCount: internalEdges.length,
    internalEdges: internalEdges.map(edge => edge.map(index => points[index].id)) };
  if (triangles.length !== points.length - 2 || internalEdges.length !== points.length - 3 || !result.areaConserved || !result.trianglesCounterclockwise || !result.allVerticesUsed || !boundaryMatched || !internalMatched) throw new Error('Triangulation consistency checks failed; no mesh is exportable.');
  return result;
}

export function triangulate(rawInput, coordinates) {
  const input = validateInput(rawInput);
  if (!keys(coordinates, input.vertices.map(vertex => vertex.id))) throw new Error('Supply one exact coordinate for every declared vertex.');
  const points = input.vertices.map((vertex, index) => ({ id: vertex.id, originalIndex: index, ...validatePoint(coordinates[vertex.id]) })), n = points.length, reasons = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (points[i].x === points[j].x && points[i].y === points[j].y) reasons.push({ code: 'duplicate_points', vertexIds: [points[i].id, points[j].id] });
  for (let i = 0; i < n; i++) if (cross(points[(i + n - 1) % n], points[i], points[(i + 1) % n]) === 0n) reasons.push({ code: 'collinear_corner', vertexId: points[i].id });
  const signedTwiceArea = signedArea(points), twiceArea = signedTwiceArea < 0n ? -signedTwiceArea : signedTwiceArea;
  if (signedTwiceArea === 0n) reasons.push({ code: 'zero_area' });
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if ((i + 1) % n === j || (j + 1) % n === i) continue;
    if (intersects(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) reasons.push({ code: 'nonadjacent_edges_intersect', edges: [[points[i].id, points[(i + 1) % n].id], [points[j].id, points[(j + 1) % n].id]] });
  }
  const sourceHash = hash({ manifest: input, points }), base = { sourceHash, points, signedTwiceArea: signedTwiceArea.toString(), absoluteTwiceArea: twiceArea.toString(),
    originalWinding: signedTwiceArea > 0n ? 'ccw' : signedTwiceArea < 0n ? 'cw' : 'degenerate', valid: reasons.length === 0, reasons };
  if (reasons.length) return { ...base, mesh: null };
  const ccw = points.map((_, index) => index); if (signedTwiceArea < 0n) ccw.reverse();
  const active = [...ccw], triangles = [];
  const emit = indices => { const vertices = indices.map(index => points[index]); triangles.push({ id: `t${triangles.length + 1}`, vertexIds: vertices.map(vertex => vertex.id), originalIndices: [...indices], vertices: vertices.map(({ id, x, y }) => ({ id, x, y })), twiceArea: cross(...vertices).toString() }); };
  while (active.length > 3) {
    const ears = active.filter((index, position) => {
      const previous = active[(position + active.length - 1) % active.length], next = active[(position + 1) % active.length];
      return cross(points[previous], points[index], points[next]) > 0n && active.every(other => [previous, index, next].includes(other) || !insideTriangle(points[previous], points[index], points[next], points[other]));
    }).sort((a, b) => a - b);
    if (!ears.length) throw new Error('No valid ear found; no mesh is exportable.');
    const position = active.indexOf(ears[0]); emit([active[(position + active.length - 1) % active.length], active[position], active[(position + 1) % active.length]]); active.splice(position, 1);
  }
  emit(active);
  const mesh = { version: 1, sourceHash, policyHash: POLICY_HASH, unit: input.unit, ccwVertexOrder: ccw.map(index => points[index].id), triangles, certificate: certificate(points, ccw, triangles, twiceArea) };
  return { ...base, mesh };
}
export function polygonAnalysis(rawInput, answers) {
  const input = validateInput(rawInput);
  if (!Array.isArray(answers) || answers.length !== input.vertices.length) throw new Error('Supply one ordered response for every vertex.');
  const parsed = Array.from(answers, (answer, index) => {
    if (!keys(answer, ['vertexId', 'text']) || answer.vertexId !== input.vertices[index].id || answer.text !== null && typeof answer.text !== 'string') throw new Error('Response order or shape differs from the declared outline.');
    return answer.text === null ? { kind: 'missing', point: null } : parsePoint(answer.text);
  });
  const missingVertexIds = input.vertices.filter((_, index) => parsed[index].kind === 'missing').map(vertex => vertex.id), unknownVertexIds = input.vertices.filter((_, index) => parsed[index].kind === 'unknown').map(vertex => vertex.id);
  const status = missingVertexIds.length ? 'incomplete' : unknownVertexIds.length ? 'unknown' : 'complete';
  return { status, missingVertexIds, unknownVertexIds, analysis: status === 'complete' ? triangulate(input, Object.fromEntries(input.vertices.map((vertex, index) => [vertex.id, parsed[index].point]))) : null };
}
export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed outline definition or vertex order. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved vertex coordinate request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = input.vertices.map(vertex => {
    const attempt = state.attempts.find(row => row.taskId === vertex.id), answer = attempt?.observation?.answer;
    return { vertexId: vertex.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, point: answer?.point ?? null, questionId: attempt?.questionId ?? null,
      attemptId: attempt?.id ?? null, responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = polygonAnalysis(input, answers.map(({ vertexId, text }) => ({ vertexId, text })));
  const active = answers.find(answer => ['create_unknown', 'pending'].includes(answer.status));
  const status = active?.status ?? (answers.some(answer => answer.status === 'unasked') ? 'ready' : calculation.status);
  return { version: 1, outlineId: input.outlineId, source: input, manifestHash: hash(input), sourceHash: calculation.analysis?.sourceHash ?? null,
    configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH, participant: state.config.participant, room: state.room,
    answers, ...calculation, status, sourceInspected: false, actionsExecuted: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'point', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parsePoint(answer.text)) !== hash({ kind: answer.kind, point: answer.point })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved vertex coordinate evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain vertex coordinate evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or editor.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parsePoint(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
