/* MediaPipe Tasks Vision runs on the viewer's device. Only normalized points are saved. */
const HAND_EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const POSE_EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[24,26],[26,28],[28,30],[30,32]];
const POSE_IDS = [11,12,13,14,15,16,23,24];
const LIVE_WIDTH = 512;
const LIVE_POSE_INTERVAL = 3;
const LIVE_MIN_INTERVAL_MS = 60;
const CLIP_FPS = 8;
let modelPromise, lastTimestamp = 0;
function nextTimestamp() { lastTimestamp = Math.max(performance.now(), lastTimestamp + 1); return lastTimestamp; }
async function models(progress = () => {}) {
  if (window.SignVisionModels) return window.SignVisionModels;
  if (!modelPromise) {
    const work = (async () => {
    progress('trackingLibrary');
    const mp = await import('/mediapipe/vision_bundle.mjs');
    const vision = await mp.FilesetResolver.forVisionTasks('/mediapipe/wasm');
    progress('trackingHandModel');
    const hands = await mp.HandLandmarker.createFromOptions(vision, {baseOptions: {modelAssetPath: '/mediapipe/hand_landmarker.task'}, runningMode: 'VIDEO', numHands: 2});
    progress('trackingPoseModel');
    const pose = await mp.PoseLandmarker.createFromOptions(vision, {baseOptions: {modelAssetPath: '/mediapipe/pose_landmarker_lite.task'}, runningMode: 'VIDEO', numPoses: 1});
    return {hands, pose};
    })();
    let timer;
    modelPromise = Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MediaPipe loading timed out')), 25000); })])
      .catch(error => { modelPromise = null; throw error; }).finally(() => clearTimeout(timer));
  }
  return modelPromise;
}
function detect(image, includePose = true) {
  const {hands, pose} = window.SignVisionModels;
  const timestamp = nextTimestamp();
  const handResult = hands.detectForVideo(image, timestamp);
  const poseResult = includePose ? pose.detectForVideo(image, timestamp) : null;
  const bySide = {};
  (handResult.landmarks || []).forEach((points, index) => {
    const side = handResult.handednesses?.[index]?.[0]?.categoryName;
    if (side === 'Left' || side === 'Right') bySide[side] = points;
  });
  return {hands: bySide, pose: poseResult?.landmarks?.[0] || null};
}
function point(p) { return [p.x, p.y, p.z]; }
function norm(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function features(detection) {
  const pose = detection.pose?.length >= 33 ? detection.pose.map(point) : null;
  const left = detection.hands.Left?.length === 21 ? detection.hands.Left.map(point) : null;
  const right = detection.hands.Right?.length === 21 ? detection.hands.Right.map(point) : null;
  const visible = [left, right].filter(Boolean);
  let origin = [0, 0, 0], scale = 1;
  if (pose) {
    origin = pose[11].map((n, k) => (n + pose[12][k]) / 2);
    scale = Math.max(norm(pose[11], pose[12]), .05);
  } else if (visible.length) {
    origin = visible[0][0].map((n, k) => visible.reduce((sum, hand) => sum + hand[0][k], 0) / visible.length);
    scale = Math.max(norm(visible[0][0], visible[visible.length - 1][0]), norm(visible[0][0], visible[0][9]) * 3, .05);
  }
  const output = [], wrists = [];
  for (const hand of [left, right]) {
    if (!hand) { output.push(...Array(127).fill(0)); wrists.push(0, 0, 0); continue; }
    const global = hand.flatMap(p => p.map((n, k) => (n - origin[k]) / scale));
    const palm = Math.max(norm(hand[0], hand[9]), 1e-5);
    const local = hand.flatMap(p => p.map((n, k) => (n - hand[0][k]) / palm));
    output.push(1, ...global, ...local); wrists.push(...global.slice(0, 3));
  }
  output.push(...(pose ? POSE_IDS.flatMap(id => pose[id].map((n, k) => (n - origin[k]) / scale)) : Array(24).fill(0)), ...wrists);
  return output;
}
function draw(canvas, video, detection) {
  const width = video.videoWidth || 640, height = video.videoHeight || 480;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  const skeleton = (points, edges, color, pose = false) => {
    if (!points) return;
    const visible = i => points[i] && (!pose || points[i].visibility === undefined || points[i].visibility >= .6);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    for (const [a, b] of edges) {
      if (!visible(a) || !visible(b)) continue;
      ctx.beginPath(); ctx.moveTo(points[a].x * canvas.width, points[a].y * canvas.height);
      ctx.lineTo(points[b].x * canvas.width, points[b].y * canvas.height); ctx.stroke();
    }
    for (const index of (pose ? [...new Set(edges.flat())] : points.map((_, i) => i))) {
      if (!visible(index)) continue;
      ctx.beginPath(); ctx.arc(points[index].x * canvas.width, points[index].y * canvas.height, 3, 0, Math.PI * 2); ctx.fill();
    }
  };
  skeleton(detection.pose, POSE_EDGES, '#56a8ff', true);
  for (const hand of Object.values(detection.hands)) skeleton(hand, HAND_EDGES, '#28b978');
}
window.LiveTracking = class {
  constructor(video, overlay, onChange) {
    this.video = video; this.overlay = overlay; this.onChange = onChange; this.active = false; this.run = 0;
    this.capture = document.createElement('canvas'); this.captureContext = this.capture.getContext('2d', {alpha: false});
    this.qualityCanvas = document.createElement('canvas'); this.qualityCanvas.width = 16; this.qualityCanvas.height = 12;
    this.qualityContext = this.qualityCanvas.getContext('2d', {willReadFrequently: true});
  }
  async start() {
    this.stop(); this.active = true; const run = this.run;
    this.onChange({key: 'trackingLoading'});
    this.watchdog = setTimeout(() => { if (run === this.run) this.fail('tracking_timeout'); }, 30000);
    try { window.SignVisionModels = await models(key => { if (run === this.run) this.onChange({key}); }); }
    catch (error) { console.error('MediaPipe initialization failed', error); if (run === this.run) this.fail('tracking_failed'); return; }
    clearTimeout(this.watchdog);
    if (!this.active || run !== this.run) return;
    this.frameIndex = 0; this.lastPose = null; this.lastHands = -1; this.lastStatusAt = 0;
    const schedule = () => {
      if (!this.active || run !== this.run) return;
      if (typeof this.video.requestVideoFrameCallback === 'function') this.frameHandle = this.video.requestVideoFrameCallback(tick);
      else this.timer = setTimeout(tick, LIVE_MIN_INTERVAL_MS);
    };
    const tick = () => {
      if (!this.active || run !== this.run) return;
      if (this.lastResult && performance.now() - this.lastResult < LIVE_MIN_INTERVAL_MS) { schedule(); return; }
      if (this.video.readyState >= 2 && this.video.videoWidth) {
        try {
          const width = Math.min(LIVE_WIDTH, this.video.videoWidth);
          const height = Math.round(width * this.video.videoHeight / this.video.videoWidth);
          if (this.capture.width !== width || this.capture.height !== height) { this.capture.width = width; this.capture.height = height; }
          this.captureContext.drawImage(this.video, 0, 0, width, height);
          const refreshPose = this.frameIndex++ % LIVE_POSE_INTERVAL === 0;
          const detection = detect(this.capture, refreshPose);
          if (refreshPose) this.lastPose = detection.pose;
          detection.pose = this.lastPose;
          draw(this.overlay, this.video, detection);
          const now = performance.now(), fps = this.lastResult ? Math.min(30, 1000 / (now - this.lastResult)).toFixed(1) : '—';
          this.lastResult = now;
          const handCount = Object.keys(detection.hands).length;
          if (this.onFrame) {
            let quality = null;
            if (this.frameIndex % 8 === 0) {
              this.qualityContext.drawImage(this.capture, 0, 0, 16, 12);
              const pixels = this.qualityContext.getImageData(0, 0, 16, 12).data;
              let sum = 0;
              for (let p = 0; p < pixels.length; p += 4) sum += (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3;
              const points = Object.values(detection.hands).flat();
              const edge = points.length ? points.filter(p => p.x < .08 || p.x > .92 || p.y < .08 || p.y > .92).length / points.length : 0;
              quality = {brightness: sum / (pixels.length / 4), edge_ratio: edge};
            }
            this.onFrame(features(detection), now, quality);
          }
          if (handCount !== this.lastHands || now - this.lastStatusAt >= 500) {
            this.onChange({key: handCount ? 'trackingFound' : 'trackingNoHands', hands: handCount, body: !!detection.pose, fps});
            this.lastHands = handCount; this.lastStatusAt = now;
          }
        } catch (error) { console.error('MediaPipe frame failed', error); this.fail('tracking_failed'); return; }
      }
      schedule();
    };
    schedule();
  }
  fail(key) { this.stop(); this.onChange({key, error: true}); }
  stop() {
    this.active = false; this.run++; clearTimeout(this.timer); clearTimeout(this.watchdog);
    if (this.frameHandle !== undefined && typeof this.video.cancelVideoFrameCallback === 'function') this.video.cancelVideoFrameCallback(this.frameHandle);
    this.frameHandle = undefined; this.lastResult = null; this.lastPose = null;
    this.overlay.getContext('2d').clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
};
window.GestureEngine = {
  async ready() { window.SignVisionModels = await models(); return true; },
  async selfTest() {
    await this.ready();
    const response = await fetch('/mediapipe/test-hands.jpg');
    if (!response.ok) throw new Error('Test image unavailable');
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const result = detect(canvas);
    bitmap.close();
    return Object.keys(result.hands).length;
  },
  async extract(blob) {
    window.SignVisionModels = await models();
    const url = URL.createObjectURL(blob), video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
    try {
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Не удалось открыть видео')); });
      if (video.readyState < 2) await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Не удалось прочитать видео')); });
      let duration = video.duration;
      if (!Number.isFinite(duration)) {
        video.currentTime = 1e10;
        await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = () => reject(new Error('Не удалось прочитать длительность видео')); });
        duration = video.currentTime;
      }
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось прочитать длительность видео');
      const count = Math.min(64, Math.max(1, Math.floor(duration * CLIP_FPS)));
      const sequence = [];
      const capture = document.createElement('canvas');
      capture.width = Math.min(LIVE_WIDTH, video.videoWidth);
      capture.height = Math.round(capture.width * video.videoHeight / video.videoWidth);
      const context = capture.getContext('2d', {alpha: false});
      let lastPose = null;
      for (let i = 0; i < count; i++) {
        const time = Math.min(duration - .001, i / CLIP_FPS);
        if (Math.abs(video.currentTime - time) > .001) {
          video.currentTime = time;
          await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = () => reject(new Error('Не удалось прочитать кадр')); });
        }
        context.drawImage(video, 0, 0, capture.width, capture.height);
        const refreshPose = i % 2 === 0;
        const detection = detect(capture, refreshPose);
        if (refreshPose) lastPose = detection.pose;
        detection.pose = lastPose;
        sequence.push(features(detection));
        if (i % 6 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      return sequence;
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  }
};
