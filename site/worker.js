const FEATURES = 284;
const HAND = 127;
const MAX_SAMPLES = 300;
const MAX_SAMPLES_PER_PHRASE = 25;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const sampleCache = new WeakMap();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const error = (message, status = 400) => json({ detail: message }, status);

function handRatio(value) {
  return value.filter((frame) => frame[0] > 0.5 || frame[HAND] > 0.5).length / value.length;
}
function validSequence(value, minHandRatio = 0.35) {
  return (
    Array.isArray(value) &&
    value.length >= 8 &&
    value.length <= 96 &&
    value.every(
      (frame) => Array.isArray(frame) && frame.length === FEATURES && frame.every(Number.isFinite),
    ) &&
    handRatio(value) >= minHandRatio
  );
}
function trimSequence(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  const visible = (frame) => Array.isArray(frame) && (frame[0] > 0.5 || frame[HAND] > 0.5);
  const first = value.findIndex(visible);
  if (first < 0) {
    return [];
  }
  let last = value.length - 1;
  while (last > first && !visible(value[last])) {
    last--;
  }
  return value.slice(first, last + 1);
}
function missingHandsPrediction(frames) {
  return {
    state: 'unknown',
    phrase_id: null,
    candidate_id: null,
    advice_code: 'hands_visible',
    reason_code: 'insufficient_hands',
    frames,
    distance: null,
  };
}

async function samples(bucket, catalog) {
  const ids = phraseIds(catalog);
  const cached = sampleCache.get(bucket);
  if (cached && Date.now() - cached.at < 10000) {
    return cached.items.filter((item) => ids.has(item.phrase_id));
  }
  const found = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix: 'samples/', cursor, limit: 1000 });
    for (const object of listed.objects) {
      const response = await bucket.get(object.key);
      if (!response) {
        continue;
      }
      const sample = await response.json();
      if (typeof sample.phrase_id === 'string' && validSequence(sample.sequence)) {
        found.push({
          ...sample,
          created_at: Number.isFinite(sample.created_at)
            ? sample.created_at
            : object.uploaded
              ? new Date(object.uploaded).getTime()
              : null,
          key: object.key,
          sample_id: object.key
            .split('/')
            .pop()
            .replace(/\.json$/, ''),
        });
      }
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor && found.length < MAX_SAMPLES);
  sampleCache.set(bucket, { at: Date.now(), items: found });
  return found.filter((item) => ids.has(item.phrase_id));
}
function counts(items, catalog) {
  const count = Object.fromEntries(catalog.map((phrase) => [phrase.id, 0]));
  for (const item of items) {
    if (Object.hasOwn(count, item.phrase_id)) {
      count[item.phrase_id]++;
    }
  }
  return count;
}
function resample(frames, target = 32) {
  const output = [];
  for (let i = 0; i < target; i++) {
    const position = (i * (frames.length - 1)) / (target - 1);
    const low = Math.floor(position),
      high = Math.ceil(position),
      mix = position - low;
    const row = frames[low].map((value, index) => value * (1 - mix) + frames[high][index] * mix);
    const nearest = frames[Math.round(position)];
    for (const offset of [0, HAND]) {
      row[offset] = nearest[offset];
      if (!row[offset]) {
        row.fill(0, offset + 1, offset + HAND);
      }
    }
    output.push(row);
  }
  return output;
}
function averageDiff(a, b, start, length) {
  let sum = 0;
  let weight = 0;
  for (let k = 0; k < length; k++) {
    // MediaPipe depth is noisier than the image plane, especially for fingers.
    const coordinateWeight = k % 3 === 2 ? 0.2 : 1;
    sum += coordinateWeight * Math.abs(a[start + k] - b[start + k]);
    weight += coordinateWeight;
  }
  return sum / weight;
}
function frameDistance(a, b) {
  let sum = 0,
    terms = 0;
  for (const offset of [0, HAND]) {
    if (a[offset] > 0.5 !== b[offset] > 0.5) {
      sum += 1;
    } else if (a[offset] > 0.5) {
      sum += 0.55 * averageDiff(a, b, offset + 1, 63) + 0.45 * averageDiff(a, b, offset + 64, 63);
    }
    if (a[offset] > 0.5 || b[offset] > 0.5) {
      terms++;
    }
  }
  sum += 0.25 * averageDiff(a, b, HAND * 2, 24) + 0.35 * averageDiff(a, b, FEATURES - 6, 6);
  return sum / (terms + 0.6);
}
function distance(a, b) {
  const n = a.length,
    m = b.length,
    radius = Math.max(4, Math.floor(Math.max(n, m) / 4));
  let previous = Array(m + 1).fill(Infinity);
  previous[0] = 0;
  for (let i = 1; i <= n; i++) {
    const current = Array(m + 1).fill(Infinity);
    const center = (i * m) / n;
    for (
      let j = Math.max(1, Math.floor(center - radius));
      j <= Math.min(m, Math.floor(center + radius) + 1);
      j++
    ) {
      const va = a[i - 1],
        vaPrev = a[Math.max(0, i - 2)];
      const vb = b[j - 1],
        vbPrev = b[Math.max(0, j - 2)];
      let movement = 0;
      for (let k = FEATURES - 6; k < FEATURES; k++) {
        movement += Math.abs(va[k] - vaPrev[k] - (vb[k] - vbPrev[k]));
      }
      current[j] =
        frameDistance(va, vb) +
        (0.3 * movement) / 6 +
        Math.min(previous[j], current[j - 1], previous[j - 1]);
    }
    previous = current;
  }
  // DTW can align a partial/reversed movement to repeated poses. Keep the
  // complete displacement of each visible wrist as additional evidence.
  let trajectory = 0;
  let visibleHands = 0;
  for (const [mask, offset] of [
    [0, FEATURES - 6],
    [HAND, FEATURES - 3],
  ]) {
    if (a[0][mask] > 0.5 && a[n - 1][mask] > 0.5 && b[0][mask] > 0.5 && b[m - 1][mask] > 0.5) {
      trajectory += Math.hypot(
        a[n - 1][offset] - a[0][offset] - (b[m - 1][offset] - b[0][offset]),
        a[n - 1][offset + 1] - a[0][offset + 1] - (b[m - 1][offset + 1] - b[0][offset + 1]),
      );
      visibleHands++;
    }
  }
  return previous[m] / Math.max(n, m) + (visibleHands ? (0.15 * trajectory) / visibleHands : 0);
}
function motion(sequence) {
  const first = sequence.find((frame) => frame[0] > 0.5 || frame[HAND] > 0.5);
  const last = [...sequence].reverse().find((frame) => frame[0] > 0.5 || frame[HAND] > 0.5);
  if (!first || !last) {
    return [0, 0];
  }
  const offset = first[0] > 0.5 && last[0] > 0.5 ? FEATURES - 6 : FEATURES - 3;
  return [last[offset] - first[offset], last[offset + 1] - first[offset + 1]];
}
function pathSpeed(sequence, duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  let path = 0;
  for (let i = 1; i < sequence.length; i++) {
    const a = sequence[i - 1],
      b = sequence[i];
    const offset =
      a[0] > 0.5 && b[0] > 0.5
        ? FEATURES - 6
        : a[HAND] > 0.5 && b[HAND] > 0.5
          ? FEATURES - 3
          : null;
    if (offset !== null) {
      path += Math.hypot(b[offset] - a[offset], b[offset + 1] - a[offset + 1]);
    }
  }
  return path / duration;
}
function advice(query, reference, quality = {}) {
  const coverage =
    query.filter((frame) => frame[0] > 0.5 || frame[HAND] > 0.5).length / query.length;
  if (coverage < 0.65) {
    return 'hands_visible';
  }
  if (Number.isFinite(quality.brightness) && quality.brightness < 65) {
    return 'lighting';
  }
  if (Number.isFinite(quality.edge_ratio) && quality.edge_ratio > 0.3) {
    return 'step_back';
  }
  if (Number.isFinite(quality.pose_coverage) && quality.pose_coverage < 0.5) {
    return 'body_visible';
  }
  if (!reference) {
    return 'repeat';
  }
  const q = motion(query),
    r = motion(reference.sequence);
  const qm = Math.hypot(...q),
    rm = Math.hypot(...r);
  if (rm > 0.2 && qm > 0.2 && q[0] * r[0] + q[1] * r[1] < -0.05) {
    return 'direction';
  }
  if (
    Number.isFinite(reference.duration_s) &&
    Number.isFinite(quality.duration_s) &&
    reference.duration_s > 0.5
  ) {
    const referenceSpeed = pathSpeed(reference.sequence, reference.duration_s);
    const querySpeed = pathSpeed(query, quality.duration_s);
    if (referenceSpeed > 0.12 && querySpeed > 0.12) {
      if (querySpeed > referenceSpeed * 1.5) {
        return 'slower';
      }
      if (querySpeed < referenceSpeed * 0.65) {
        return 'faster';
      }
    }
  }
  return 'hand_shape';
}
function predict(
  sequence,
  dataset,
  language,
  live = false,
  quality = {},
  catalog = BUILTIN_PHRASES,
) {
  const ru = language !== 'en';
  if (!dataset.length) {
    return {
      state: 'empty_dataset',
      phrase_id: null,
      candidate_id: null,
      text: ru ? 'Неизвестный жест' : 'Unknown gesture',
      distance: null,
      margin: null,
      reason_code: 'empty_dataset',
      frames: sequence.length,
    };
  }
  const query = live ? null : resample(sequence);
  const fps =
    live && Number.isFinite(quality.duration_s) && quality.duration_s > 0
      ? (sequence.length - 1) / quality.duration_s
      : 8;
  const windows = new Map();
  const ranked = dataset
    .flatMap((item) => {
      const sizes = live
        ? [
            ...new Set(
              [0.75, 1, 1.25].map((speed) =>
                Math.max(8, Math.round((item.duration_s || 2.5) * fps * speed)),
              ),
            ),
          ]
        : [sequence.length];
      const ends = live ? [0, Math.max(1, Math.round(fps * 0.3))] : [0];
      let bestWindow = null;
      const reference = item.sequence.length === 32 ? item.sequence : resample(item.sequence);
      for (const size of sizes) {
        for (const end of ends) {
          if (size + end > sequence.length) {
            continue;
          }
          const key = `${size}:${end}`;
          if (!windows.has(key)) {
            const raw = sequence.slice(sequence.length - size - end, sequence.length - end);
            windows.set(key, { raw, normalized: handRatio(raw) >= 0.35 ? resample(raw) : null });
          }
          const window = windows.get(key);
          if (!window.normalized) {
            continue;
          }
          const value = distance(live ? window.normalized : query, reference);
          if (!bestWindow || value < bestWindow.value) {
            bestWindow = { label: item.phrase_id, value, reference: item, window: window.raw };
          }
        }
      }
      return bestWindow ? [bestWindow] : [];
    })
    .sort((a, b) => a.value - b.value);
  if (!ranked.length) {
    return {
      state: 'waiting',
      phrase_id: null,
      candidate_id: null,
      reason_code: 'waiting',
      frames: sequence.length,
    };
  }
  const byPhrase = new Map();
  for (const item of ranked) {
    if (!byPhrase.has(item.label)) {
      byPhrase.set(item.label, []);
    }
    byPhrase.get(item.label).push(item);
  }
  const classes = [...byPhrase]
    .map(([label, items]) => {
      const close = items
        .filter((item) => item.value <= items[0].value + 0.05)
        .slice(0, SITE_CONFIG.recognition.neighbors);
      const score =
        0.8 * items[0].value +
        (0.2 * close.reduce((sum, item) => sum + item.value, 0)) / close.length;
      return { label, score, reference: items[0].reference, window: items[0].window };
    })
    .sort((a, b) => a.score - b.score);
  const winner = classes[0].label,
    best = classes[0].score;
  const margin = classes.length > 1 ? classes[1].score - best : null;
  // An absolute margin alone rejects even an exact match if a similar phrase exists.
  // Require both a small absolute gap and a small relative gap to call it ambiguous.
  const relativeMargin = margin === null ? 1 : margin / Math.max(best + margin, 0.001);
  const reason_code =
    best > SITE_CONFIG.recognition.max_distance
      ? 'too_far'
      : margin !== null &&
          margin < SITE_CONFIG.recognition.min_margin &&
          (best > 0.03 || relativeMargin < 0.2)
        ? 'ambiguous'
        : 'recognized';
  const phrase_id = reason_code === 'recognized' ? winner : null;
  const plausible = best <= SITE_CONFIG.recognition.tentative_distance;
  const state = reason_code === 'recognized' ? 'recognized' : plausible ? 'tentative' : 'unknown';
  const candidate_id = state === 'tentative' ? winner : null;
  const selectedWindow = classes[0].window;
  const selectedQuality = live
    ? { ...quality, duration_s: (selectedWindow.length - 1) / fps }
    : quality;
  const phrase = catalog.find((item) => item.id === phrase_id);
  return {
    state,
    phrase_id,
    candidate_id,
    alternative_id: reason_code === 'ambiguous' ? classes[1]?.label || null : null,
    advice_code:
      state === 'recognized'
        ? null
        : advice(selectedWindow, candidate_id ? classes[0].reference : null, selectedQuality),
    text: phrase ? (ru ? phrase.text : phrase.en) : ru ? 'Неизвестный жест' : 'Unknown gesture',
    distance: best,
    margin,
    reason_code,
    frames: sequence.length,
  };
}
async function body(request) {
  if (Number(request.headers.get('content-length') || 0) > 9000000) {
    throw new Error('Слишком много данных');
  }
  return request.json();
}
function language(request) {
  return request.headers.get('accept-language')?.startsWith('en') ? 'en' : 'ru';
}
function serve(path) {
  const asset = SITE_ASSETS[path];
  if (!asset) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(asset.body, {
    headers: { 'content-type': asset.type, 'cache-control': 'no-store' },
  });
}
async function mediapipeAsset(path) {
  const wasm = /^\/mediapipe\/wasm\/vision_wasm_(?:internal|nosimd_internal)\.(?:js|wasm)$/;
  const sources = {
    '/mediapipe/vision_bundle.mjs':
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs',
    '/mediapipe/hand_landmarker.task':
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    '/mediapipe/pose_landmarker_lite.task':
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    '/mediapipe/test-hands.jpg':
      'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg',
  };
  const source =
    sources[path] ||
    (wasm.test(path)
      ? `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm/${path.split('/').pop()}`
      : null);
  if (!source) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const upstream = await fetch(source);
    if (!upstream.ok) {
      return new Response('Model asset unavailable', { status: 502 });
    }
    const type = path.endsWith('.wasm')
      ? 'application/wasm'
      : path.endsWith('.task')
        ? 'application/octet-stream'
        : path.endsWith('.jpg')
          ? 'image/jpeg'
          : 'text/javascript; charset=utf-8';
    return new Response(upstream.body, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
    });
  } catch (caught) {
    console.error('MediaPipe asset failed', path, caught);
    return new Response('Model asset unavailable', { status: 502 });
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path.startsWith('/static/')) {
      return serve(path === '/' ? '/index.html' : path);
    }
    if (path.startsWith('/mediapipe/')) {
      return mediapipeAsset(path);
    }
    if (!path.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }
    if (!env.BUCKET) {
      return error('Хранилище сайта пока недоступно', 503);
    }
    try {
      if (path === '/api/me' && request.method === 'GET') {
        if (!env.DB) {
          throw new ApiError('Профили временно недоступны.', 503);
        }
        const { identity, account, authMethod } = await accountFor(request, env.DB);
        const hasEmailPassword = account
          ? !!(await env.DB.prepare('SELECT account_id FROM email_credentials WHERE account_id = ?')
              .bind(account.id)
              .first())
          : false;
        return json({
          authenticated: !!identity,
          registered: !!account,
          account,
          auth_method: authMethod || null,
          has_email_password: hasEmailPassword,
          suggested_name: identity?.fullName || identity?.email?.split('@')[0] || '',
        });
      }
      if (path.startsWith('/api/email/')) {
        if (!env.DB) {
          throw new ApiError('Профили временно недоступны.', 503);
        }
        if (request.method !== 'POST') {
          return error('Method not allowed', 405);
        }
        if (path === '/api/email/logout') {
          const { cookie } = await logoutEmail(request, env.DB);
          const response = json({ ok: true });
          response.headers.set('set-cookie', cookie);
          return response;
        }
        const data = await body(request);
        if (path === '/api/email/link') {
          return json(await linkEmailPassword(request, env, data));
        }
        const result =
          path === '/api/email/register'
            ? await registerEmail(request, env, data)
            : path === '/api/email/login'
              ? await loginEmail(request, env, data)
              : null;
        if (!result) {
          return error('Not found', 404);
        }
        const response = json({ account: result.account });
        response.headers.set('set-cookie', result.cookie);
        return response;
      }
      if (path === '/api/lessons' && request.method === 'GET') {
        if (!env.DB) {
          throw new ApiError('Уроки временно недоступны.', 503);
        }
        return json(await listLessons(request, env));
      }
      const lessonVideo = path.match(/^\/api\/lessons\/([a-z0-9_]+)\/video$/);
      if (lessonVideo && request.method === 'GET') {
        return await serveLessonVideo(env, lessonVideo[1]);
      }
      if (path === '/api/config' && request.method === 'GET') {
        const catalog = await phraseCatalog(env.DB);
        return json({
          phrases: catalog,
          counts: counts(await samples(env.BUCKET, catalog), catalog),
          min_frames: 8,
          sample_fps: 8,
        });
      }
      if (path === '/api/admin/users' && request.method === 'GET') {
        return json({ users: await usersForAdmin(request, env.DB) });
      }
      if (path === '/api/admin/samples' && request.method === 'GET') {
        await requireAdmin(request, env.DB);
        const catalog = await phraseCatalog(env.DB);
        return json({
          samples: (await samples(env.BUCKET, catalog)).map(
            ({ sample_id, phrase_id, duration_s, created_at, uploader_id, uploader_name }) => ({
              sample_id,
              phrase_id,
              duration_s,
              created_at,
              uploader_id: uploader_id || null,
              uploader_name: uploader_name || null,
            }),
          ),
        });
      }
      const removeSample = path.match(/^\/api\/admin\/samples\/([0-9a-f-]+)$/);
      if (removeSample && request.method === 'DELETE') {
        await requireAdmin(request, env.DB);
        const catalog = await phraseCatalog(env.DB);
        const existing = await samples(env.BUCKET, catalog);
        const item = existing.find((sample) => sample.sample_id === removeSample[1]);
        if (!item) {
          throw new ApiError('Эталон не найден.', 404);
        }
        await env.BUCKET.delete(item.key);
        sampleCache.delete(env.BUCKET);
        return json({
          removed: item.sample_id,
          counts: counts(
            existing.filter((sample) => sample !== item),
            catalog,
          ),
        });
      }
      const lessonAdmin = path.match(/^\/api\/admin\/lessons\/([a-z0-9_]+)(\/video)?$/);
      if (lessonAdmin && lessonAdmin[2] && request.method === 'PUT') {
        return json(await uploadLessonVideo(request, env, lessonAdmin[1]));
      }
      if (lessonAdmin && lessonAdmin[2] && request.method === 'DELETE') {
        return json(await deleteLessonVideo(request, env, lessonAdmin[1]));
      }
      if (request.method !== 'POST') {
        return error('Method not allowed', 405);
      }
      const data = await body(request),
        lang = language(request);
      if (path === '/api/register') {
        return json({ account: await registerAccount(request, env, data) });
      }
      if (path === '/api/admin/phrases') {
        return json({ phrase: await createPhrase(request, env, data) }, 201);
      }
      const userRole = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
      if (userRole) {
        return json({
          account: await changeUserRole(
            request,
            env.DB,
            decodeURIComponent(userRole[1]),
            data.role,
          ),
        });
      }
      if (lessonAdmin && !lessonAdmin[2]) {
        return json(await saveLessonMaterial(request, env, lessonAdmin[1], data));
      }
      const lessonAction = path.match(/^\/api\/lessons\/([a-z0-9_]+)\/(start|practice)$/);
      if (lessonAction && lessonAction[2] === 'start') {
        return json(await startLesson(request, env, lessonAction[1]));
      }
      if (lessonAction && lessonAction[2] === 'practice') {
        return json(await practiceLesson(request, env, lessonAction[1], data));
      }
      if (path === '/api/samples') {
        const uploader = await requireAdmin(request, env.DB);
        const catalog = await phraseCatalog(env.DB);
        if (!phraseIds(catalog).has(data.phrase_id)) {
          return error('Неизвестная фраза');
        }
        const trimmed = trimSequence(data.sequence);
        if (!validSequence(trimmed, 0.65)) {
          return error('Недостаточно кадров или рук в кадре', 422);
        }
        const existing = await samples(env.BUCKET, catalog);
        if (existing.length >= MAX_SAMPLES) {
          return error('Достигнут лимит примеров', 413);
        }
        if (
          existing.filter((sample) => sample.phrase_id === data.phrase_id).length >=
          MAX_SAMPLES_PER_PHRASE
        ) {
          return error('Достигнут лимит примеров для фразы', 413);
        }
        const id = crypto.randomUUID();
        const sequence = resample(trimmed).map((frame) =>
          frame.map((value) => Math.round(value * 10000) / 10000),
        );
        const duration_s =
          Number.isFinite(data.duration_s) && data.duration_s > 0 && data.duration_s <= 60
            ? (data.duration_s * trimmed.length) / data.sequence.length
            : null;
        const key = `samples/${data.phrase_id}/${id}.json`;
        const saved = {
          phrase_id: data.phrase_id,
          sequence,
          duration_s,
          created_at: Date.now(),
          uploader_id: uploader.id,
          uploader_name: uploader.display_name,
        };
        await env.BUCKET.put(key, JSON.stringify(saved), {
          httpMetadata: { contentType: 'application/json' },
        });
        existing.push({ ...saved, key, sample_id: id });
        sampleCache.set(env.BUCKET, { at: Date.now(), items: existing });
        return json({ sample_id: id, frames: trimmed.length, counts: counts(existing, catalog) });
      }
      if (path === '/api/recognize') {
        if (!validSequence(data.sequence, 0)) {
          return error('Недостаточно кадров или неверный формат записи', 422);
        }
        const sequence = trimSequence(data.sequence);
        if (!validSequence(sequence)) {
          return json(missingHandsPrediction(sequence.length));
        }
        const catalog = await phraseCatalog(env.DB);
        return json(
          predict(
            sequence,
            await samples(env.BUCKET, catalog),
            lang,
            false,
            { ...data.quality, duration_s: data.duration_s },
            catalog,
          ),
        );
      }
      if (path === '/api/live') {
        if (
          !validSequence(data.sequence, 0) ||
          handRatio(data.sequence) * data.sequence.length < 8
        ) {
          return json({
            state: 'waiting',
            phrase_id: null,
            candidate_id: null,
            advice_code: 'hands_visible',
          });
        }
        const catalog = await phraseCatalog(env.DB);
        return json(
          predict(
            data.sequence,
            await samples(env.BUCKET, catalog),
            lang,
            true,
            { ...data.quality, duration_s: data.duration_s },
            catalog,
          ),
        );
      }
      if (path === '/api/evaluate') {
        if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 30) {
          return error('Нужно от 1 до 30 видео');
        }
        const catalog = await phraseCatalog(env.DB),
          ids = phraseIds(catalog);
        const dataset = await samples(env.BUCKET, catalog),
          results = [];
        for (const item of data.items) {
          if (!ids.has(item.expected) && item.expected !== 'unknown') {
            return error('Неизвестная метка');
          }
          const sequence = trimSequence(item.sequence);
          if (!validSequence(sequence)) {
            results.push({
              file: item.file,
              expected: item.expected,
              predicted: null,
              correct: false,
              error: 'Недостаточно кадров или рук в кадре',
            });
            continue;
          }
          const predicted =
            predict(sequence, dataset, lang, false, {}, catalog).phrase_id || 'unknown';
          results.push({
            file: item.file,
            expected: item.expected,
            predicted,
            correct: predicted === item.expected,
          });
        }
        const correct = results.filter((row) => row.correct).length;
        return json({
          total: results.length,
          correct,
          accuracy: correct / results.length,
          results,
        });
      }
      return error('Not found', 404);
    } catch (caught) {
      if (caught instanceof ApiError) {
        return error(
          language(request) === 'en'
            ? API_ERROR_EN[caught.message] || caught.message
            : caught.message,
          caught.status,
        );
      }
      console.error('SignVision request failed', caught);
      return error('Не удалось выполнить запрос. Попробуйте ещё раз.', 500);
    }
  },
};
