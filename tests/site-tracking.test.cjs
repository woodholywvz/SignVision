const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

test('reference loading releases the start button after a timeout and can recover', async () => {
  const source = fs.readFileSync('site/app.js', 'utf8');
  const refreshCode = source.slice(
    source.indexOf('async function refresh()'),
    source.indexOf('function setFeedback('),
  );
  let expire;
  let failed = true;
  const context = vm.createContext({
    configLoading: false,
    configError: null,
    phrases: [],
    counts: {},
    AbortController,
    renderControls() {},
    applyLocale() {},
    t: (key) => key,
    setTimeout: (callback) => {
      expire = callback;
      return 1;
    },
    clearTimeout() {},
    fetch: (_url, { signal }) =>
      failed
        ? new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          })
        : Promise.resolve({
            ok: true,
            json: async () => ({ phrases: [{ id: 'privet' }], counts: { privet: 12 } }),
          }),
  });
  vm.runInContext(refreshCode, context);
  const first = context.refresh();
  assert.equal(context.configLoading, true);
  const rejected = assert.rejects(first, /referencesTimeout/);
  expire();
  await rejected;
  assert.equal(context.configLoading, false);
  assert.equal(context.configError.message, 'referencesTimeout');
  failed = false;
  await context.refresh();
  assert.equal(context.configError, null);
  assert.equal(context.counts.privet, 12);
});

test('tracking reports a stalled video stream instead of listening forever', async () => {
  let now = 0;
  let nextTimer = 0;
  let cancelled = false;
  const timers = new Map();
  const states = [];
  const window = { SignVisionModels: {} };
  vm.runInNewContext(fs.readFileSync('site/tracking.js', 'utf8'), {
    window,
    document: { createElement: () => ({ getContext: () => ({ clearRect() {} }) }) },
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    console,
  });
  const tracker = new window.LiveTracking(
    {
      requestVideoFrameCallback: () => 1,
      cancelVideoFrameCallback: () => {
        cancelled = true;
      },
    },
    { width: 1, height: 1, getContext: () => ({ clearRect() {} }) },
    (state) => states.push(state),
  );
  await tracker.start();
  const watchdog = [...timers.values()].find((timer) => timer.delay === 12000);
  now = 12001;
  watchdog.callback();
  assert.equal(tracker.active, false);
  assert.equal(states.at(-1).key, 'tracking_no_frames');
  assert.equal(states.at(-1).error, true);
  assert.equal(cancelled, true);
});

test('a timed-out live request can retry and stopping aborts its current request', async () => {
  const source = fs.readFileSync('site/app.js', 'utf8');
  const liveCode = source.slice(
    source.indexOf('function stopLive()'),
    source.indexOf("$('liveButton').addEventListener"),
  );
  const signals = [];
  let expire;
  const context = vm.createContext({
    live: true,
    liveGeneration: 1,
    liveFrames: [],
    liveQuality: {},
    liveFrameAt: 0,
    liveSentAt: 0,
    livePending: false,
    liveRequest: null,
    resultState: { phase: 'starting' },
    tracker: {},
    AbortController,
    setTimeout: (callback) => {
      expire = callback;
      return 1;
    },
    clearTimeout() {},
    renderControls() {},
    renderResult() {},
    t: (key) => key,
    api: (_url, _data, signal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  vm.runInContext(liveCode, context);
  for (let i = 1; i <= 12; i++) {
    context.liveFrame(Array(284).fill(0), i * 150, null);
  }
  assert.equal(context.resultState.phase, 'listening');
  assert.equal(signals.length, 1);
  assert.equal(context.livePending, true);
  expire();
  await new Promise(setImmediate);
  assert.equal(context.livePending, false);
  assert.equal(context.resultState.error, 'liveRequestTimeout');
  context.liveFrame(Array(284).fill(0), 3400, null);
  assert.equal(signals.length, 2);
  context.stopLive();
  await new Promise(setImmediate);
  assert.equal(signals[1].aborted, true);
  assert.equal(context.livePending, false);
  assert.equal(context.live, false);
});

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
    window: {},
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

test('sound waits for user interaction and respects the saved mute preference', async () => {
  const storage = new Map();
  const listeners = new Map();
  let notes = 0;
  const button = { setAttribute() {} };
  class AudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    async resume() {
      this.state = 'running';
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    }
    createOscillator() {
      return {
        frequency: {},
        connect() {},
        disconnect() {},
        start() {
          notes++;
        },
        stop() {},
      };
    }
  }
  const window = { AudioContext };
  const localStorage = {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  };
  vm.runInNewContext(fs.readFileSync('site/sounds.js', 'utf8'), {
    window,
    localStorage,
    document: {
      getElementById: () => button,
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
  });
  window.SignVisionSounds.init((key) => key);
  window.SignVisionSounds.play('lesson');
  assert.equal(notes, 0);
  await listeners.get('pointerdown')();
  assert.ok(notes > 0);
  button.onclick();
  const count = notes;
  window.SignVisionSounds.play('login');
  assert.equal(notes, count);
  assert.equal(storage.get('signvision.sound'), 'off');
  assert.equal(button.title, 'enableSounds');
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
    catalogLoaded: false,
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
