const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

test('the account form opens before slow lesson and admin requests finish', async () => {
  const source = fs.readFileSync('site/learning.js', 'utf8');
  const init = source.slice(
    source.indexOf('  async function init()'),
    source.indexOf('  function refreshAccountContent()'),
  );
  const elements = new Map();
  const events = [];
  let resolveMe;
  const me = new Promise((resolve) => {
    resolveMe = resolve;
  });
  const context = vm.createContext({
    $: (id) => {
      if (!elements.has(id)) {
        elements.set(id, {});
      }
      return elements.get(id);
    },
    state: {},
    location: { search: '?tab=account' },
    URLSearchParams,
    render: () => events.push('render'),
    setPanel: (name) => events.push(name),
    getJson: () => me,
    refreshAccountContent: () => events.push('background'),
    isAdmin: () => false,
    renderAdminSamples() {},
  });
  vm.runInContext(init, context);
  const pending = context.init();
  assert.deepEqual(events, ['render', 'account']);
  assert.equal(typeof elements.get('emailAuthForm').onsubmit, 'function');
  resolveMe({ authenticated: false });
  await pending;
  assert.deepEqual(events, ['render', 'account', 'render', 'background']);
});

test('the result card shows advice for recorded, unknown, and waiting predictions', () => {
  const source = fs.readFileSync('site/app.js', 'utf8');
  const render = source.slice(
    source.indexOf('function renderResult()'),
    source.indexOf('function renderEvaluation()'),
  );
  const elements = new Map();
  const context = vm.createContext({
    $: (id) => {
      if (!elements.has(id)) {
        elements.set(id, { classList: { toggle() {} } });
      }
      return elements.get(id);
    },
    phrases: [],
    counts: {},
    live: false,
    window: {},
    t: (key) => key,
    phraseName: (id) => id,
    resultState: {},
  });
  vm.runInContext(render, context);
  for (const phase of ['unknown', 'tentative', 'listening']) {
    context.resultState = {
      phase,
      prediction: { candidate_id: 'privet', advice_code: 'lighting' },
    };
    vm.runInContext('renderResult()', context);
    assert.equal(elements.get('resultDetail').textContent, 'advice_lighting');
  }
});

test('live tracking uses new video frames, small input, and fewer pose passes', async () => {
  const callbacks = new Map();
  let nextHandle = 0,
    now = 0,
    handCalls = 0,
    poseCalls = 0,
    cancelled = false;
  const context = () => ({
    drawImage() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
  });
  const capture = { width: 0, height: 0, getContext: context };
  const overlay = { width: 0, height: 0, getContext: context };
  const video = {
    videoWidth: 960,
    videoHeight: 720,
    readyState: 4,
    requestVideoFrameCallback(callback) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback(handle) {
      cancelled = callbacks.delete(handle);
    },
  };
  const hand = Array.from({ length: 21 }, (_, i) => ({ x: 0.2 + i / 100, y: 0.3 + i / 100, z: 0 }));
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const window = {
    SignVisionModels: {
      hands: {
        detectForVideo() {
          handCalls++;
          return { landmarks: [hand], handednesses: [[{ categoryName: 'Left' }]] };
        },
      },
      pose: {
        detectForVideo() {
          poseCalls++;
          return { landmarks: [pose] };
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('site/tracking.js', 'utf8'), {
    window,
    document: { createElement: () => capture },
    performance: { now: () => now },
    setTimeout,
    clearTimeout,
    console,
  });
  const tracker = new window.LiveTracking(video, overlay, () => {});
  await tracker.start();
  for (let i = 0; i < 4; i++) {
    now += 80;
    const [handle, callback] = callbacks.entries().next().value;
    callbacks.delete(handle);
    callback();
  }
  assert.equal(handCalls, 4);
  assert.equal(poseCalls, 2);
  assert.equal(capture.width, 512);
  assert.equal(capture.height, 384);
  tracker.stop();
  assert.equal(cancelled, true);
  assert.equal(callbacks.size, 0);
});

test('clip extraction samples a long recording without processing every source frame', async () => {
  let handCalls = 0,
    poseCalls = 0,
    currentTime = 0;
  const video = {
    duration: 8,
    videoWidth: 960,
    videoHeight: 720,
    readyState: 4,
    set src(_) {
      queueMicrotask(() => this.onloadedmetadata?.());
    },
    set currentTime(value) {
      currentTime = value;
      queueMicrotask(() => this.onseeked?.());
    },
    get currentTime() {
      return currentTime;
    },
    removeAttribute() {},
    load() {},
  };
  const capture = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  const hand = Array.from({ length: 21 }, (_, i) => ({ x: 0.2 + i / 100, y: 0.3 + i / 100, z: 0 }));
  const pose = Array.from({ length: 33 }, (_, i) => ({ x: 0.4 + i / 1000, y: 0.5, z: 0 }));
  const window = {
    SignVisionModels: {
      hands: {
        detectForVideo() {
          handCalls++;
          return { landmarks: [hand], handednesses: [[{ categoryName: 'Left' }]] };
        },
      },
      pose: {
        detectForVideo() {
          poseCalls++;
          return { landmarks: [pose] };
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('site/tracking.js', 'utf8'), {
    window,
    document: { createElement: (tag) => (tag === 'video' ? video : { ...capture }) },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    performance: { now: () => handCalls * 100 },
    setTimeout,
    clearTimeout,
    console,
  });
  const analysis = await window.GestureEngine.analyze({});
  const sequence = analysis.sequence;
  assert.equal(sequence.length, 64);
  assert.equal(handCalls, 64);
  assert.equal(poseCalls, 32);
  assert.equal(analysis.duration_s, 8);
  assert.equal(analysis.quality.pose_coverage, 1);
  assert.equal(sequence[0][0], 1);
  video.duration = 9;
  await assert.rejects(window.GestureEngine.extract({}), /videoTooLong/);
  assert.equal(handCalls, 64);
});

test('hand depth is not mixed with pose depth', () => {
  const window = {};
  const context = vm.createContext({ window });
  vm.runInContext(
    fs.readFileSync('site/tracking.js', 'utf8') + '\nwindow.testFeatures = features;',
    context,
  );
  const hand = Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + i * 0.002, y: 0.4, z: i * 0.01 }));
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0.8 }));
  pose[11].x = 0.4;
  pose[12].x = 0.6;
  const frame = window.testFeatures({ hands: { Left: hand }, pose });
  assert.equal(frame[3], 0);
  assert.equal(frame[280], 0);
});
