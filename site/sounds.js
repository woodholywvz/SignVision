/* Short, quiet cues synthesized locally; audio starts only after interaction. */
(function () {
  const patterns = {
    lesson: [
      [523.25, 0.12],
      [659.25, 0.12],
      [783.99, 0.18],
      [1046.5, 0.28],
    ],
    register: [
      [523.25, 0.14],
      [659.25, 0.14],
      [880, 0.26],
    ],
    login: [
      [587.33, 0.16],
      [783.99, 0.24],
    ],
  };
  let enabled = true,
    context,
    output,
    pending,
    translate,
    initialized = false;
  try {
    enabled = localStorage.getItem('signvision.sound') !== 'off';
  } catch (_) {
    /* private browsing */
  }

  function render() {
    const button = document.getElementById('soundButton');
    if (!button || !translate) {
      return;
    }
    const label = translate(enabled ? 'muteSounds' : 'enableSounds');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = label;
    button.textContent = enabled ? '♫' : '♩';
  }
  function play(name) {
    if (!enabled || !patterns[name]) {
      return;
    }
    if (!context || context.state !== 'running') {
      pending = name;
      return;
    }
    pending = null;
    try {
      let start = context.currentTime + 0.02;
      for (const [frequency, duration] of patterns[name]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.3, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.1);
        oscillator.connect(gain);
        gain.connect(output);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(start);
        oscillator.stop(start + duration + 0.12);
        start += duration;
      }
    } catch (_) {
      /* Optional audio must never interrupt learning or sign-in. */
    }
  }
  async function unlock() {
    if (!enabled) {
      return;
    }
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) {
        return;
      }
      if (!context) {
        context = new Audio();
        output = context.createGain();
        output.gain.value = 0.14;
        output.connect(context.destination);
      }
      if (context.state === 'suspended') {
        await context.resume();
      }
      if (pending) {
        play(pending);
      }
    } catch (_) {
      /* Audio unavailable or blocked by the browser. */
    }
  }
  window.SignVisionSounds = {
    play,
    render,
    markLogin() {
      try {
        sessionStorage.setItem('signvision.loginSound', String(Date.now()));
      } catch (_) {
        /* private browsing */
      }
    },
    completeLogin(authenticated) {
      try {
        const markedAt = Number(sessionStorage.getItem('signvision.loginSound'));
        if (authenticated && markedAt) {
          sessionStorage.removeItem('signvision.loginSound');
          if (Date.now() - markedAt < 10 * 60 * 1000) {
            play('login');
          }
        }
      } catch (_) {
        /* private browsing */
      }
    },
    init(t) {
      translate = t;
      render();
      if (initialized) {
        return;
      }
      initialized = true;
      document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
      document.addEventListener('keydown', unlock, { capture: true });
      document.getElementById('soundButton').onclick = () => {
        enabled = !enabled;
        pending = null;
        if (output) {
          output.gain.value = enabled ? 0.14 : 0;
        }
        try {
          localStorage.setItem('signvision.sound', enabled ? 'on' : 'off');
        } catch (_) {
          /* private browsing */
        }
        render();
        if (enabled) {
          unlock();
        }
      };
    },
  };
})();
