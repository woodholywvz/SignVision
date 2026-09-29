const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

test('live tracking uses new video frames, small input, and fewer pose passes', async () => {
  const callbacks = new Map();
  let nextHandle = 0, now = 0, handCalls = 0, poseCalls = 0, cancelled = false;
  const context = () => ({drawImage() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}});
  const capture = {width: 0, height: 0, getContext: context};
  const overlay = {width: 0, height: 0, getContext: context};
  const video = {
    videoWidth: 960, videoHeight: 720, readyState: 4,
    requestVideoFrameCallback(callback) { const handle = ++nextHandle; callbacks.set(handle, callback); return handle; },
    cancelVideoFrameCallback(handle) { cancelled = callbacks.delete(handle); },
  };
  const hand = Array.from({length: 21}, (_, i) => ({x: .2 + i / 100, y: .3 + i / 100, z: 0}));
  const pose = Array.from({length: 33}, () => ({x: .5, y: .5, z: 0, visibility: 1}));
  const window = {SignVisionModels: {
    hands: {detectForVideo() { handCalls++; return {landmarks: [hand], handednesses: [[{categoryName: 'Left'}]]}; }},
    pose: {detectForVideo() { poseCalls++; return {landmarks: [pose]}; }},
  }};
  vm.runInNewContext(fs.readFileSync('site/tracking.js', 'utf8'), {
    window, document: {createElement: () => capture}, performance: {now: () => now},
    setTimeout, clearTimeout, console,
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
  let handCalls = 0, poseCalls = 0, currentTime = 0;
  const video = {
    duration: 8, videoWidth: 960, videoHeight: 720, readyState: 4,
    set src(_) { queueMicrotask(() => this.onloadedmetadata?.()); },
    set currentTime(value) { currentTime = value; queueMicrotask(() => this.onseeked?.()); },
    get currentTime() { return currentTime; },
    removeAttribute() {}, load() {},
  };
  const capture = {width: 0, height: 0, getContext: () => ({drawImage() {}})};
  const hand = Array.from({length: 21}, (_, i) => ({x: .2 + i / 100, y: .3 + i / 100, z: 0}));
  const pose = Array.from({length: 33}, (_, i) => ({x: .4 + i / 1000, y: .5, z: 0}));
  const window = {SignVisionModels: {
    hands: {detectForVideo() { handCalls++; return {landmarks: [hand], handednesses: [[{categoryName: 'Left'}]]}; }},
    pose: {detectForVideo() { poseCalls++; return {landmarks: [pose]}; }},
  }};
  vm.runInNewContext(fs.readFileSync('site/tracking.js', 'utf8'), {
    window, document: {createElement: tag => tag === 'video' ? video : capture},
    URL: {createObjectURL: () => 'blob:test', revokeObjectURL() {}},
    performance: {now: () => handCalls * 100}, setTimeout, clearTimeout, console,
  });
  const sequence = await window.GestureEngine.extract({});
  assert.equal(sequence.length, 64);
  assert.equal(handCalls, 64);
  assert.equal(poseCalls, 32);
  assert.equal(capture.width, 512);
  assert.equal(sequence[0][0], 1);
  video.duration = 9;
  await assert.rejects(window.GestureEngine.extract({}), /videoTooLong/);
  assert.equal(handCalls, 64);
});

test('hand depth is not mixed with pose depth', () => {
  const window = {};
  const context = vm.createContext({window});
  vm.runInContext(fs.readFileSync('site/tracking.js', 'utf8') + '\nwindow.testFeatures = features;', context);
  const hand = Array.from({length: 21}, (_, i) => ({x: .3 + i * .002, y: .4, z: i * .01}));
  const pose = Array.from({length: 33}, () => ({x: .5, y: .5, z: .8}));
  pose[11].x = .4; pose[12].x = .6;
  const frame = window.testFeatures({hands: {Left: hand}, pose});
  assert.equal(frame[3], 0);
  assert.equal(frame[280], 0);
});
