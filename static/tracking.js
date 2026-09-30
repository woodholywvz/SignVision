/* One frame in flight at a time prevents a growing queue on slower computers. */
window.LiveTracking = class {
  constructor(video, overlay, onChange) {
    this.video = video;
    this.overlay = overlay;
    this.onChange = onChange;
    this.capture = document.createElement('canvas');
    this.active = false;
    this.run = 0;
    this.handEdges = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [0, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [5, 9],
      [9, 10],
      [10, 11],
      [11, 12],
      [9, 13],
      [13, 14],
      [14, 15],
      [15, 16],
      [13, 17],
      [0, 17],
      [17, 18],
      [18, 19],
      [19, 20],
    ];
    this.poseEdges = [
      [11, 12],
      [11, 13],
      [13, 15],
      [12, 14],
      [14, 16],
      [11, 23],
      [12, 24],
      [23, 24],
      [23, 25],
      [25, 27],
      [27, 29],
      [29, 31],
      [27, 31],
      [24, 26],
      [26, 28],
      [28, 30],
      [30, 32],
      [28, 32],
    ];
  }

  start() {
    this.stop();
    this.active = true;
    const run = this.run;
    this.onChange({ key: 'trackingLoading' });
    const url = new URL('/api/track', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = (this.socket = new WebSocket(url));
    this.watchdog = setTimeout(() => this.fail('tracking_timeout'), 30000);
    socket.onmessage = (event) => {
      if (!this.active || run !== this.run) {
        return;
      }
      clearTimeout(this.watchdog);
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        this.fail('tracking_failed');
        return;
      }
      if (data.type === 'error') {
        this.fail(data.code);
        return;
      }
      if (data.type === 'landmarks') {
        this.draw(data);
        const now = performance.now();
        const fps = this.lastResult ? Math.min(10, 1000 / (now - this.lastResult)).toFixed(1) : '—';
        this.lastResult = now;
        this.onChange({
          key: data.hands.length ? 'trackingFound' : 'trackingNoHands',
          hands: data.hands.length,
          body: data.pose.length > 0,
          fps,
        });
      }
      this.sendTimer = setTimeout(
        () => this.send(run),
        data.type === 'ready' ? 0 : Math.max(0, 100 - (performance.now() - this.sentAt)),
      );
    };
    socket.onerror = () => {
      if (this.active && run === this.run) {
        this.fail('tracking_failed');
      }
    };
    socket.onclose = () => {
      if (this.active && run === this.run) {
        this.fail('tracking_disconnected');
      }
    };
  }

  send(run) {
    if (!this.active || run !== this.run || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.video.readyState < 2 || !this.video.videoWidth) {
      this.sendTimer = setTimeout(() => this.send(run), 100);
      return;
    }
    const width = Math.min(640, this.video.videoWidth);
    this.capture.width = width;
    this.capture.height = Math.round((width * this.video.videoHeight) / this.video.videoWidth);
    this.capture
      .getContext('2d')
      .drawImage(this.video, 0, 0, this.capture.width, this.capture.height);
    this.capture.toBlob(
      (blob) => {
        if (!this.active || run !== this.run || this.socket?.readyState !== WebSocket.OPEN) {
          return;
        }
        if (!blob) {
          this.fail('invalid_frame');
          return;
        }
        this.sentAt = performance.now();
        this.socket.send(blob);
        this.watchdog = setTimeout(() => this.fail('tracking_timeout'), 10000);
      },
      'image/jpeg',
      0.75,
    );
  }

  draw(data) {
    const canvas = this.overlay;
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / 640;
    const skeleton = (points, edges, color, pose = false) => {
      const visible = (index) => points[index] && (!pose || points[index][3] >= 0.6);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2 * scale;
      for (const [a, b] of edges) {
        if (!visible(a) || !visible(b)) {
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(points[a][0] * canvas.width, points[a][1] * canvas.height);
        ctx.lineTo(points[b][0] * canvas.width, points[b][1] * canvas.height);
        ctx.stroke();
      }
      const ids = pose ? [...new Set(edges.flat())] : points.map((_, index) => index);
      for (const index of ids) {
        if (!visible(index)) {
          continue;
        }
        ctx.beginPath();
        ctx.arc(
          points[index][0] * canvas.width,
          points[index][1] * canvas.height,
          3 * scale,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.8 * scale;
        ctx.stroke();
      }
    };
    skeleton(data.pose, this.poseEdges, '#56a8ff', true);
    for (const hand of data.hands) {
      skeleton(hand.points, this.handEdges, '#28b978');
    }
  }

  fail(key) {
    this.stop();
    this.onChange({ key, error: true });
  }

  stop() {
    this.active = false;
    this.run += 1;
    this.lastResult = null;
    clearTimeout(this.sendTimer);
    clearTimeout(this.watchdog);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
    this.overlay.getContext('2d').clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
};
