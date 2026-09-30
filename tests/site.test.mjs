import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../dist/server/index.js';
import { environment, request } from './site-env.mjs';
const sequence = Array.from({ length: 12 }, () => {
  const frame = Array(284).fill(0);
  frame[0] = 1;
  return frame;
});

test('reference loading reads bounded batches and keeps every existing sample', async () => {
  const env = environment();
  for (let i = 0; i < 17; i++) {
    await env.BUCKET.put(
      `samples/privet/${i}.json`,
      JSON.stringify({ phrase_id: 'privet', sequence }),
    );
  }
  const read = env.BUCKET.get.bind(env.BUCKET);
  let active = 0,
    peak = 0;
  env.BUCKET.get = async (key) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    const result = await read(key);
    active--;
    return result;
  };
  const config = await (await worker.fetch(request('/api/config'), env)).json();
  assert.equal(config.counts.privet, 17);
  assert.ok(peak > 1 && peak <= 6);
});

test('hosted Site saves landmarks and recognizes a known sequence', async () => {
  const env = environment();
  const saved = await worker.fetch(request('/api/samples', { phrase_id: 'privet', sequence }), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).counts.privet, 1);
  const recognized = await worker.fetch(request('/api/recognize', { sequence }), env);
  assert.equal((await recognized.json()).phrase_id, 'privet');
  const config = await worker.fetch(request('/api/config'), env);
  assert.equal((await config.json()).counts.privet, 1);
});

test('hosted Site rejects sequences without hands', async () => {
  const env = environment();
  const absent = sequence.map(() => Array(284).fill(0));
  const response = await worker.fetch(
    request('/api/samples', { phrase_id: 'privet', sequence: absent }),
    env,
  );
  assert.equal(response.status, 422);
});

test('live translation separates matches, suggestions and distant gestures', async () => {
  const env = environment();
  await worker.fetch(
    request('/api/samples', { phrase_id: 'privet', sequence, duration_s: 2 }),
    env,
  );
  const live = async (frames, quality = {}) =>
    (
      await worker.fetch(request('/api/live', { sequence: frames, quality, duration_s: 2 }), env)
    ).json();
  assert.equal((await live(sequence)).state, 'recognized');
  const shifted = (value) =>
    sequence.map((frame) => {
      const next = [...frame];
      for (let index = 1; index <= 63; index++) {
        next[index] = value;
      }
      return next;
    });
  const tentative = await live(shifted(0.9), { brightness: 30 });
  assert.equal(tentative.state, 'tentative');
  assert.equal(tentative.phrase_id, null);
  assert.equal(tentative.candidate_id, 'privet');
  assert.equal(tentative.advice_code, 'lighting');
  const distant = await live(shifted(2));
  assert.equal(distant.state, 'unknown');
  assert.equal(distant.candidate_id, null);
  assert.equal(distant.advice_code, 'repeat');
  assert.equal((await live(sequence.map(() => Array(284).fill(0)))).state, 'waiting');
});

test('recorded uncertain gestures and missing hands receive actionable feedback', async () => {
  const env = environment();
  await worker.fetch(request('/api/samples', { phrase_id: 'privet', sequence }), env);
  const uncertain = sequence.map((frame) => {
    const row = [...frame];
    row.fill(0.9, 1, 64);
    return row;
  });
  for (const [quality, expected] of [
    [{ brightness: 30 }, 'lighting'],
    [{ edge_ratio: 0.6 }, 'step_back'],
    [{ pose_coverage: 0 }, 'body_visible'],
  ]) {
    const result = await (
      await worker.fetch(request('/api/recognize', { sequence: uncertain, quality }), env)
    ).json();
    assert.equal(result.state, 'tentative');
    assert.equal(result.candidate_id, 'privet');
    assert.equal(result.advice_code, expected);
  }
  const absent = sequence.map(() => Array(284).fill(0));
  for (const path of ['/api/recognize', '/api/live']) {
    const result = await (await worker.fetch(request(path, { sequence: absent }), env)).json();
    assert.equal(result.phrase_id, null);
    assert.equal(result.advice_code, 'hands_visible');
  }
});

test('overlapping hello and goodbye references are ambiguous rather than a confident word', async () => {
  const env = environment();
  for (const phrase_id of ['privet', 'do_svidaniya']) {
    await worker.fetch(request('/api/samples', { phrase_id, sequence, duration_s: 2 }), env);
  }
  for (const path of ['/api/recognize', '/api/live']) {
    const result = await (
      await worker.fetch(request(path, { sequence, duration_s: 2 }), env)
    ).json();
    assert.equal(result.state, 'tentative');
    assert.equal(result.reason_code, 'ambiguous');
    assert.equal(result.phrase_id, null);
    assert.equal(result.advice_code, 'hand_shape');
  }
});

function movingHand({ length = 24, depth = 0, shift = 0, endpointNoise = 0 } = {}) {
  return Array.from({ length }, (_, index) => {
    const frame = Array(284).fill(0);
    frame[0] = 1;
    const position = index / (length - 1);
    for (let point = 0; point < 21; point++) {
      frame[1 + point * 3] = position + shift;
      frame[2 + point * 3] = 0.2 + shift;
      frame[3 + point * 3] = point ? depth : 0;
      frame[64 + point * 3] = point / 21;
      frame[65 + point * 3] = point / 42;
      frame[66 + point * 3] = point ? depth : 0;
    }
    frame[278] = position + shift;
    if (index === length - 1) {
      frame[278] += endpointNoise;
      for (let point = 0; point < 21; point++) {
        frame[1 + point * 3] += endpointNoise;
      }
    }
    return frame;
  });
}

test('finger depth distinguishes nearby classes despite a small position shift', async () => {
  const env = environment();
  for (const [phrase_id, depth] of [
    ['privet', 0],
    ['do_svidaniya', 0.65],
  ]) {
    await worker.fetch(
      request('/api/samples', { phrase_id, sequence: movingHand({ depth }), duration_s: 3 }),
      env,
    );
  }
  for (const path of ['/api/recognize', '/api/live']) {
    const result = await (
      await worker.fetch(
        request(path, {
          sequence: movingHand({ depth: 0.08, shift: 0.18 }),
          duration_s: 3,
        }),
        env,
      )
    ).json();
    assert.equal(result.phrase_id, 'privet');
    assert.ok(result.margin > 0.05);
  }
});

test('one noisy wrist endpoint does not reject a matching trajectory', async () => {
  const env = environment();
  await worker.fetch(
    request('/api/samples', { phrase_id: 'privet', sequence: movingHand(), duration_s: 3 }),
    env,
  );
  for (const endpointNoise of [-2.2, 2.2]) {
    for (const path of ['/api/recognize', '/api/live']) {
      const result = await (
        await worker.fetch(
          request(path, {
            sequence: movingHand({ shift: 0.1, endpointNoise }),
            duration_s: 3,
          }),
          env,
        )
      ).json();
      assert.equal(result.phrase_id, 'privet');
      assert.ok(result.distance < 0.3);
    }
  }
});

test('an exact match is accepted even when a nearby class is inside the absolute margin', async () => {
  const env = environment();
  const nearby = sequence.map((frame) => {
    const row = [...frame];
    row.fill(0.08, 1, 64);
    return row;
  });
  await worker.fetch(request('/api/samples', { phrase_id: 'privet', sequence }), env);
  await worker.fetch(request('/api/samples', { phrase_id: 'do_svidaniya', sequence: nearby }), env);
  const result = await (await worker.fetch(request('/api/recognize', { sequence }), env)).json();
  assert.equal(result.phrase_id, 'privet');
  assert.ok(result.margin < 0.05);
});

test('live matching tolerates tempo changes and a trailing pause without accepting reversed motion', async () => {
  const env = environment();
  const gesture = (length, reverse = false, depthNoise = 0) =>
    Array.from({ length }, (_, i) => {
      const row = Array(284).fill(0);
      const position = reverse ? 1 - i / (length - 1) : i / (length - 1);
      row[0] = 1;
      for (let j = 1; j <= 63; j += 3) {
        row[j] = position;
        row[j + 1] = 0.2;
        row[j + 2] = depthNoise * Math.sin(i);
      }
      row[278] = position;
      return row;
    });
  await worker.fetch(
    request('/api/samples', { phrase_id: 'privet', sequence: gesture(24), duration_s: 3 }),
    env,
  );
  for (const length of [18, 30]) {
    const performed = gesture(length, false, 0.4);
    const frames = [
      ...Array.from({ length: 12 }, () => Array(284).fill(0)),
      ...performed,
      performed.at(-1),
      performed.at(-1),
    ];
    const result = await (
      await worker.fetch(
        request('/api/live', { sequence: frames, duration_s: (frames.length - 1) / 8 }),
        env,
      )
    ).json();
    assert.equal(result.phrase_id, 'privet');
  }
  const reversed = await (
    await worker.fetch(request('/api/recognize', { sequence: gesture(24, true) }), env)
  ).json();
  assert.equal(reversed.phrase_id, null);
});

test('extra examples of another phrase cannot outvote an exact reference', async () => {
  const env = environment();
  const shifted = sequence.map((frame) => {
    const row = [...frame];
    for (let i = 1; i <= 63; i++) {
      row[i] = 0.4;
    }
    return row;
  });
  await worker.fetch(request('/api/samples', { phrase_id: 'privet', sequence }), env);
  await worker.fetch(request('/api/samples', { phrase_id: 'spasibo', sequence: shifted }), env);
  await worker.fetch(request('/api/samples', { phrase_id: 'spasibo', sequence: shifted }), env);
  const result = await worker.fetch(request('/api/recognize', { sequence }), env);
  assert.equal((await result.json()).phrase_id, 'privet');
});

test('reference upload trims blank ends and live mode waits for a long phrase', async () => {
  const env = environment();
  const blank = Array(284).fill(0);
  const padded = [
    ...Array.from({ length: 8 }, () => blank),
    ...sequence,
    ...Array.from({ length: 8 }, () => blank),
  ];
  const saved = await worker.fetch(
    request('/api/samples', { phrase_id: 'privet', sequence: padded, duration_s: 3.5 }),
    env,
  );
  assert.equal((await saved.json()).frames, 12);
  const recording = await worker.fetch(request('/api/recognize', { sequence: padded }), env);
  assert.equal((await recording.json()).phrase_id, 'privet');
  const long = Array.from({ length: 48 }, (_, i) => {
    const frame = [...sequence[0]];
    frame[1] = i / 48;
    frame[278] = i / 48;
    return frame;
  });
  const longEnv = environment();
  await worker.fetch(
    request('/api/samples', { phrase_id: 'spasibo', sequence: long, duration_s: 6 }),
    longEnv,
  );
  const early = await worker.fetch(
    request('/api/live', { sequence: long.slice(0, 24), duration_s: 3 }),
    longEnv,
  );
  assert.equal((await early.json()).state, 'waiting');
  const complete = await worker.fetch(
    request('/api/live', { sequence: long, duration_s: 6 }),
    longEnv,
  );
  const result = await complete.json();
  assert.equal(result.state, 'recognized');
  assert.equal(result.phrase_id, 'spasibo');
  const idle = [...Array.from({ length: 52 }, () => blank), ...sequence];
  const afterPause = await worker.fetch(
    request('/api/live', { sequence: idle, duration_s: 8 }),
    env,
  );
  assert.equal((await afterPause.json()).phrase_id, 'privet');
});

test('a held-out gesture variant matches its phrase while an unrelated one stays unknown', async () => {
  const env = environment();
  const gesture = (length, base, reverse = false, noise = 0) =>
    Array.from({ length }, (_, i) => {
      const progress = i / (length - 1);
      const position = base + (reverse ? 1 - progress : progress) + noise * Math.sin(i * 2);
      const frame = Array(284).fill(0);
      frame[0] = 1;
      for (let j = 1; j <= 63; j += 3) {
        frame[j] = position;
        frame[j + 1] = 0.2;
      }
      for (let j = 64; j <= 126; j += 3) {
        frame[j] = base * 0.4 + j / 500;
      }
      frame[278] = position;
      return frame;
    });
  await worker.fetch(
    request('/api/samples', { phrase_id: 'privet', sequence: gesture(16, 0) }),
    env,
  );
  await worker.fetch(
    request('/api/samples', { phrase_id: 'spasibo', sequence: gesture(16, 1.5, true) }),
    env,
  );
  const heldOut = await worker.fetch(
    request('/api/recognize', { sequence: gesture(23, 0.02, false, 0.01) }),
    env,
  );
  assert.equal((await heldOut.json()).phrase_id, 'privet');
  const unrelated = await worker.fetch(
    request('/api/recognize', { sequence: gesture(23, 4) }),
    env,
  );
  assert.equal((await unrelated.json()).phrase_id, null);
});
