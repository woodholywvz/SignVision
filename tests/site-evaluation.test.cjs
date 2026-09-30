const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function evaluationContext(files) {
  const source = fs.readFileSync('site/app.js', 'utf8');
  const labels = files.map(() => ({ value: 'privet' }));
  const states = [];
  const context = vm.createContext({
    busy: false,
    counts: { privet: 1 },
    evalState: {},
    evaluationController: null,
    AbortController,
    setTimeout,
    clearTimeout,
    $: (id) =>
      id === 'evalFiles'
        ? { files }
        : {
            querySelector: (selector) => labels[Number(selector.match(/index="(\d+)"/)[1])],
          },
    stopCamera() {},
    renderControls() {},
    renderEvaluation() {
      states.push(JSON.parse(JSON.stringify(context.evalState)));
    },
    t: (key) => key,
    errorText: (error) => error.message,
    window: { GestureEngine: {} },
  });
  vm.runInContext(
    source.slice(
      source.indexOf('function evaluationSummary('),
      source.indexOf("$('evalButton').addEventListener('click', runEvaluation)"),
    ),
    context,
  );
  return { context, states };
}

test('evaluation continues after a corrupt video and computes accuracy over completed predictions', async () => {
  const files = ['correct.webm', 'broken.mov', 'suggested.webm'].map((name) => ({ name }));
  const { context, states } = evaluationContext(files);
  const sent = [];
  context.window.GestureEngine.analyze = async (file) => {
    if (file.name === 'broken.mov') {
      throw new Error('videoUnreadable');
    }
    return { sequence: [[1]], duration_s: 2, quality: { brightness: 30 } };
  };
  context.api = async (_url, data) => {
    sent.push(data.items);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].duration_s, 2);
    assert.equal(data.items[0].quality.brightness, 30);
    const item = data.items[0];
    return { results: [{ ...item, status: 'evaluated', correct: item.file === 'correct.webm' }] };
  };
  await context.runEvaluation();
  assert.equal(sent.length, 2);
  assert.equal(context.evalState.phase, 'done');
  assert.equal(context.evalState.data.total, 3);
  assert.equal(context.evalState.data.evaluated, 2);
  assert.equal(context.evalState.data.failed, 1);
  assert.equal(context.evalState.data.accuracy, 0.5);
  assert.equal(context.evalState.data.results[1].error, 'videoUnreadable');
  assert.equal(context.busy, false);
  assert.equal(context.evaluationController, null);
  assert.ok(states.some((state) => state.phase === 'loading' && state.completed === 1));
});

test('cancelling evaluation preserves finished results and releases controls', async () => {
  const { context } = evaluationContext([{ name: 'first.webm' }, { name: 'second.webm' }]);
  let secondStarted;
  const ready = new Promise((resolve) => {
    secondStarted = resolve;
  });
  context.window.GestureEngine.analyze = (file, { signal }) => {
    if (file.name === 'first.webm') {
      return Promise.resolve({ sequence: [[1]] });
    }
    secondStarted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  context.api = async (_url, { items }) => ({
    results: [{ ...items[0], status: 'evaluated', correct: true }],
  });
  const pending = context.runEvaluation();
  await ready;
  context.evaluationController.abort(new Error('evaluationCancelled'));
  await pending;
  assert.equal(context.evalState.phase, 'cancelled');
  assert.equal(context.evalState.data.total, 2);
  assert.equal(context.evalState.data.evaluated, 1);
  assert.equal(context.evalState.data.failed, 0);
  assert.equal(context.evalState.data.accuracy, 1);
  assert.equal(context.busy, false);
  assert.equal(context.evaluationController, null);
});

test('a server timeout marks one video as failed and still evaluates the next', async () => {
  const { context } = evaluationContext([{ name: 'timeout.webm' }, { name: 'next.webm' }]);
  context.setTimeout = (callback) => setTimeout(callback, 0);
  context.window.GestureEngine.analyze = async () => ({ sequence: [[1]] });
  context.api = (_url, { items }, signal) =>
    items[0].file === 'timeout.webm'
      ? new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      : Promise.resolve({ results: [{ ...items[0], status: 'evaluated', correct: true }] });
  await context.runEvaluation();
  assert.equal(context.evalState.data.results[0].error, 'evaluationRequestTimeout');
  assert.equal(context.evalState.data.failed, 1);
  assert.equal(context.evalState.data.evaluated, 1);
  assert.equal(context.evalState.data.accuracy, 1);
});

test('evaluation requires explicit labels instead of silently using the first phrase', async () => {
  const source = fs.readFileSync('site/app.js', 'utf8');
  const context = vm.createContext({
    phrases: [{ id: 'privet' }, { id: 'spasibo' }],
    phraseName: (id) => id,
    t: (key) => key,
    document: { createElement: () => ({}) },
  });
  vm.runInContext(
    source.slice(source.indexOf('function options('), source.indexOf('function renderCatalog(')),
    context,
  );
  const select = {
    options: [],
    replaceChildren(...items) {
      this.options = items;
    },
    prepend(item) {
      this.options.unshift(item);
    },
    append(item) {
      this.options.push(item);
    },
  };
  context.options(select, true);
  assert.equal(select.value, '');
  context.options(select, true, 'spasibo');
  assert.equal(select.value, 'spasibo');
  context.options(select, true, 'unknown');
  assert.equal(select.value, 'unknown');
});

test('reading a stalled video frame times out or cancels and removes event handlers', async () => {
  let expire;
  const context = vm.createContext({
    window: {},
    setTimeout: (callback) => {
      expire = callback;
      return 1;
    },
    clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync('site/tracking.js', 'utf8'), context);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const video = {};
    const read = context.waitForVideo(video, 'onseeked', controller.signal, () => {
      video.currentTime = 0.25;
    });
    const rejected = assert.rejects(read, cancel ? /evaluationCancelled/ : /videoReadTimeout/);
    if (cancel) {
      controller.abort(new Error('evaluationCancelled'));
    } else {
      expire();
    }
    await rejected;
    assert.equal(video.onseeked, null);
    assert.equal(video.onerror, null);
  }
});
