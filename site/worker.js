const PHRASES = SITE_CONFIG.phrases;
const IDS = new Set(PHRASES.map(phrase => phrase.id));
const FEATURES = 284;
const HAND = 127;
const MAX_SAMPLES = 100;
const headers = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers});
const error = (message, status = 400) => json({detail: message}, status);

function validSequence(value) {
  return Array.isArray(value) && value.length >= 8 && value.length <= 96 &&
    value.every(frame => Array.isArray(frame) && frame.length === FEATURES && frame.every(Number.isFinite)) &&
    value.filter(frame => frame[0] > .5 || frame[HAND] > .5).length / value.length >= .35;
}

async function samples(bucket) {
  const found = [];
  let cursor;
  do {
    const listed = await bucket.list({prefix: 'samples/', cursor, limit: 1000});
    for (const object of listed.objects) {
      const response = await bucket.get(object.key);
      if (!response) continue;
      const sample = await response.json();
      if (IDS.has(sample.phrase_id) && validSequence(sample.sequence)) found.push(sample);
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor && found.length < MAX_SAMPLES);
  return found;
}
function counts(items) {
  const count = Object.fromEntries(PHRASES.map(phrase => [phrase.id, 0]));
  for (const item of items) count[item.phrase_id]++;
  return count;
}
function resample(frames, target = 32) {
  const output = [];
  for (let i = 0; i < target; i++) {
    const position = i * (frames.length - 1) / (target - 1);
    const low = Math.floor(position), high = Math.ceil(position), mix = position - low;
    const row = frames[low].map((value, index) => value * (1 - mix) + frames[high][index] * mix);
    const nearest = frames[Math.round(position)];
    for (const offset of [0, HAND]) {
      row[offset] = nearest[offset];
      if (!row[offset]) row.fill(0, offset + 1, offset + HAND);
    }
    output.push(row);
  }
  return output;
}
function averageDiff(a, b, start, length) {
  let sum = 0;
  for (let k = 0; k < length; k++) sum += Math.abs(a[start + k] - b[start + k]);
  return sum / length;
}
function frameDistance(a, b) {
  let sum = 0, terms = 0;
  for (const offset of [0, HAND]) {
    if ((a[offset] > .5) !== (b[offset] > .5)) sum += 1;
    else if (a[offset] > .5) sum += .55 * averageDiff(a, b, offset + 1, 63) + .45 * averageDiff(a, b, offset + 64, 63);
    if (a[offset] > .5 || b[offset] > .5) terms++;
  }
  sum += .25 * averageDiff(a, b, HAND * 2, 24) + .35 * averageDiff(a, b, FEATURES - 6, 6);
  return sum / (terms + .6);
}
function distance(a, b) {
  const n = a.length, m = b.length, radius = Math.max(4, Math.floor(Math.max(n, m) / 4));
  let previous = Array(m + 1).fill(Infinity); previous[0] = 0;
  for (let i = 1; i <= n; i++) {
    const current = Array(m + 1).fill(Infinity);
    const center = i * m / n;
    for (let j = Math.max(1, Math.floor(center - radius)); j <= Math.min(m, Math.floor(center + radius) + 1); j++) {
      const va = a[i - 1], vaPrev = a[Math.max(0, i - 2)];
      const vb = b[j - 1], vbPrev = b[Math.max(0, j - 2)];
      let movement = 0;
      for (let k = FEATURES - 6; k < FEATURES; k++) movement += Math.abs((va[k] - vaPrev[k]) - (vb[k] - vbPrev[k]));
      current[j] = frameDistance(va, vb) + .3 * movement / 6 + Math.min(previous[j], current[j - 1], previous[j - 1]);
    }
    previous = current;
  }
  return previous[m] / Math.max(n, m);
}
function predict(sequence, dataset, language) {
  const ru = language !== 'en';
  if (!dataset.length) return {phrase_id: null, text: ru ? 'Неизвестный жест' : 'Unknown gesture', distance: null, margin: null, reason_code: 'empty_dataset', frames: sequence.length};
  const query = resample(sequence);
  const ranked = dataset.map(item => ({label: item.phrase_id, value: distance(query, resample(item.sequence))})).sort((a, b) => a.value - b.value);
  const nearest = ranked.slice(0, SITE_CONFIG.recognition.neighbors), votes = new Map();
  for (const item of nearest) {
    const value = votes.get(item.label) || {count: 0, total: 0};
    value.count++; value.total += item.value; votes.set(item.label, value);
  }
  const winner = [...votes].sort((a, b) => b[1].count - a[1].count || a[1].total / a[1].count - b[1].total / b[1].count)[0][0];
  const best = ranked.find(item => item.label === winner).value;
  const other = ranked.find(item => item.label !== winner)?.value;
  const margin = other === undefined ? null : other - best;
  const reason_code = best > SITE_CONFIG.recognition.max_distance ? 'too_far' : margin !== null && margin < SITE_CONFIG.recognition.min_margin ? 'ambiguous' : 'recognized';
  const phrase_id = reason_code === 'recognized' ? winner : null;
  const phrase = PHRASES.find(item => item.id === phrase_id);
  return {phrase_id, text: phrase ? (ru ? phrase.text : phrase.en) : ru ? 'Неизвестный жест' : 'Unknown gesture', distance: best, margin, reason_code, frames: sequence.length};
}
async function body(request) {
  if (Number(request.headers.get('content-length') || 0) > 9000000) throw new Error('Слишком много данных');
  return request.json();
}
function language(request) { return request.headers.get('accept-language')?.startsWith('en') ? 'en' : 'ru'; }
function serve(path) {
  const asset = SITE_ASSETS[path];
  if (!asset) return new Response('Not found', {status: 404});
  return new Response(asset.body, {headers: {'content-type': asset.type, 'cache-control': 'no-store'}});
}
async function mediapipeAsset(path) {
  const wasm = /^\/mediapipe\/wasm\/vision_wasm_(?:internal|nosimd_internal)\.(?:js|wasm)$/;
  const sources = {
    '/mediapipe/vision_bundle.mjs': 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs',
    '/mediapipe/hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    '/mediapipe/pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    '/mediapipe/test-hands.jpg': 'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg',
  };
  const source = sources[path] || (wasm.test(path) ? `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm/${path.split('/').pop()}` : null);
  if (!source) return new Response('Not found', {status: 404});
  try {
    const upstream = await fetch(source);
    if (!upstream.ok) return new Response('Model asset unavailable', {status: 502});
    const type = path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.task') ? 'application/octet-stream' : path.endsWith('.jpg') ? 'image/jpeg' : 'text/javascript; charset=utf-8';
    return new Response(upstream.body, {headers: {'content-type': type, 'cache-control': 'public, max-age=86400'}});
  } catch (caught) {
    console.error('MediaPipe asset failed', path, caught);
    return new Response('Model asset unavailable', {status: 502});
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path.startsWith('/static/')) return serve(path === '/' ? '/index.html' : path);
    if (path.startsWith('/mediapipe/')) return mediapipeAsset(path);
    if (!path.startsWith('/api/')) return new Response('Not found', {status: 404});
    if (!env.BUCKET) return error('Хранилище сайта пока недоступно', 503);
    try {
      if (path === '/api/config' && request.method === 'GET') return json({phrases: PHRASES, counts: counts(await samples(env.BUCKET)), min_frames: 8, sample_fps: 8});
      if (request.method !== 'POST') return error('Method not allowed', 405);
      const data = await body(request), lang = language(request);
      if (path === '/api/samples') {
        if (!IDS.has(data.phrase_id)) return error('Неизвестная фраза');
        if (!validSequence(data.sequence)) return error('Недостаточно кадров или рук в кадре', 422);
        const existing = await samples(env.BUCKET);
        if (existing.length >= MAX_SAMPLES) return error('Достигнут лимит примеров', 413);
        const id = crypto.randomUUID();
        const sequence = resample(data.sequence).map(frame => frame.map(value => Math.round(value * 10000) / 10000));
        await env.BUCKET.put(`samples/${data.phrase_id}/${id}.json`, JSON.stringify({phrase_id: data.phrase_id, sequence}), {httpMetadata: {contentType: 'application/json'}});
        existing.push({phrase_id: data.phrase_id});
        return json({sample_id: id, frames: data.sequence.length, counts: counts(existing)});
      }
      if (path === '/api/recognize') {
        if (!validSequence(data.sequence)) return error('Недостаточно кадров или рук в кадре', 422);
        return json(predict(data.sequence, await samples(env.BUCKET), lang));
      }
      if (path === '/api/evaluate') {
        if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 30) return error('Нужно от 1 до 30 видео');
        const dataset = await samples(env.BUCKET), results = [];
        for (const item of data.items) {
          if (!IDS.has(item.expected) && item.expected !== 'unknown') return error('Неизвестная метка');
          if (!validSequence(item.sequence)) { results.push({file: item.file, expected: item.expected, predicted: null, correct: false, error: 'Недостаточно кадров или рук в кадре'}); continue; }
          const predicted = predict(item.sequence, dataset, lang).phrase_id || 'unknown';
          results.push({file: item.file, expected: item.expected, predicted, correct: predicted === item.expected});
        }
        const correct = results.filter(row => row.correct).length;
        return json({total: results.length, correct, accuracy: correct / results.length, results});
      }
      return error('Not found', 404);
    } catch (caught) {
      console.error('SignVision request failed', caught);
      return error('Не удалось выполнить запрос. Попробуйте ещё раз.', 500);
    }
  }
};
