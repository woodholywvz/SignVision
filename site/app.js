const $ = id => document.getElementById(id);
const translations = window.SIGNVISION_I18N;
const initialQuery = new URLSearchParams(location.search).get('lang');
let savedLanguage;
try { savedLanguage = localStorage.getItem('signvision.language'); } catch (_) { /* private browsing */ }
let locale = ['ru', 'en'].includes(initialQuery) ? initialQuery :
  (['ru', 'en'].includes(savedLanguage) ? savedLanguage : (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en');
let stream, recorder, chunks = [], clip, startedAt, timerId, phrases = [], counts = {};
let resultState = {phase: 'waiting'}, feedback = '', evalState = {phase: 'idle'};
let busy = false, cameraStarting = false, cameraRequest = 0;
let trackState = null;
const tracker = new window.LiveTracking($('preview'), $('landmarkOverlay'), state => {
  trackState = state; renderTracking();
});
const t = (key, values = {}) => (translations[locale][key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
function countText(number, kind) {
  const category = new Intl.PluralRules(locale).select(number);
  const ending = category === 'one' ? 'One' : category === 'few' ? 'Few' : 'Many';
  return `${number} ${t(kind + ending)}`;
}
const phraseName = id => id === 'unknown' ? t('unknown') : (() => {
  const phrase = phrases.find(item => item.id === id);
  return phrase ? (locale === 'en' ? phrase.en || phrase.text : phrase.text) : id;
})();

async function api(url, data) {
  const response = await fetch(url, {method: 'POST', headers: {'Accept-Language': locale, 'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const payload = await response.json();
  if (!response.ok) throw Error(typeof payload.detail === 'string' ? payload.detail : t('requestFailed'));
  return payload;
}
function options(select, includeUnknown = false, selected) {
  select.replaceChildren(...phrases.map(phrase => {
    const option = document.createElement('option'); option.value = phrase.id; option.textContent = phraseName(phrase.id); return option;
  }));
  if (includeUnknown) {
    const option = document.createElement('option'); option.value = 'unknown'; option.textContent = t('unknown'); select.append(option);
  }
  if (selected && Array.from(select.options).some(option => option.value === selected)) select.value = selected;
}
function renderCatalog() {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  $('datasetStatus').textContent = t('datasetCount', {count: countText(total, 'example')});
  $('totalCount').textContent = countText(total, 'example');
  $('phraseGrid').replaceChildren(...phrases.map((phrase, index) => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'phrase-card';
    card.classList.toggle('selected', $('phraseSelect').value === phrase.id);
    card.setAttribute('aria-pressed', String($('phraseSelect').value === phrase.id));
    card.onclick = () => { $('phraseSelect').value = phrase.id; renderCatalog(); };
    const number = document.createElement('span'); number.className = 'card-index'; number.textContent = String(index + 1).padStart(2, '0');
    const title = document.createElement('strong'); title.textContent = phraseName(phrase.id);
    const count = document.createElement('small'); count.textContent = countText(counts[phrase.id] || 0, 'recording');
    card.append(number, title, count); return card;
  }));
}
function renderResult() {
  const {phase, prediction, error} = resultState;
  $('result').classList.toggle('is-unknown', phase === 'unknown' || phase === 'error');
  const caption = phase === 'recognized' ? 'recognized' : phase === 'unknown' ? 'unknownState' :
    phase === 'processing' ? 'processing' : phase === 'error' ? 'errorState' : 'waiting';
  $('resultCaption').textContent = t(caption);
  if (phase === 'processing') {
    $('resultText').textContent = t('analyzing'); $('resultDetail').textContent = '';
  } else if (phase === 'error') {
    $('resultText').textContent = t('failedRecognize'); $('resultDetail').textContent = error;
  } else if (prediction) {
    $('resultText').textContent = phraseName(prediction.phrase_id || 'unknown');
    const reasonKey = prediction.reason_code === 'recognized' ? 'recognizedReason' : prediction.reason_code;
    const details = [t(reasonKey), t('frames', {n: prediction.frames})];
    if (prediction.distance !== null) details.push(t('distance', {n: prediction.distance.toFixed(3)}));
    $('resultDetail').textContent = details.join(' · ');
  } else {
    $('resultText').textContent = t('resultPlaceholder'); $('resultDetail').textContent = t('resultHint');
  }
}
function renderEvaluation() {
  const container = $('evalResult'); container.replaceChildren();
  if (evalState.phase === 'loading') { container.textContent = t('evaluating'); return; }
  if (evalState.phase === 'error') { container.textContent = evalState.error; return; }
  if (evalState.phase !== 'done') return;
  const data = evalState.data;
  const summary = document.createElement('span'); summary.className = 'eval-summary';
  summary.textContent = t('accuracy', {correct: data.correct, total: data.total, percent: Math.round(data.accuracy * 100)});
  const table = document.createElement('table'); const head = document.createElement('thead'); const headerRow = document.createElement('tr');
  ['file', 'expected', 'predicted', 'outcome'].forEach(key => { const th = document.createElement('th'); th.textContent = t(key); headerRow.append(th); });
  head.append(headerRow); table.append(head);
  const body = document.createElement('tbody');
  data.results.forEach(row => {
    const tr = document.createElement('tr');
    [row.file, phraseName(row.expected), row.predicted ? phraseName(row.predicted) : row.error, row.correct ? '✓' : '✕'].forEach(value => {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }); body.append(tr);
  });
  table.append(body); container.append(summary, table);
}
function applyLocale() {
  document.documentElement.lang = locale; document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(element => element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel)));
  document.querySelectorAll('.lang-switch button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lang === locale)));
  $('cameraState').textContent = t(stream ? 'cameraOn' : 'cameraOff');
  $('cameraState').classList.toggle('connected', !!stream);
  const selected = $('phraseSelect').value; options($('phraseSelect'), false, selected);
  document.querySelectorAll('#evalLabels select').forEach(select => options(select, true, select.value));
  if (phrases.length) renderCatalog(); else $('datasetStatus').textContent = t('loadingDataset');
  $('clipStatus').textContent = t(clip ? 'recordingAvailable' : 'noRecording');
  $('feedback').textContent = feedback; renderResult(); renderEvaluation(); renderTracking();
}
document.querySelectorAll('.lang-switch button').forEach(button => button.addEventListener('click', () => {
  locale = button.dataset.lang;
  try { localStorage.setItem('signvision.language', locale); } catch (_) { /* private browsing */ }
  const nextUrl = new URL(location.href); nextUrl.searchParams.set('lang', locale);
  history.replaceState(null, '', nextUrl);
  applyLocale();
}));
async function refresh() {
  const response = await fetch('/api/config'); if (!response.ok) throw Error(t('requestFailed'));
  const config = await response.json(); phrases = config.phrases; counts = config.counts;
  applyLocale();
}
function setFeedback(text, error = false) { feedback = text; $('feedback').textContent = text; $('feedback').classList.toggle('error', error); }
function renderControls() {
  const recording = recorder?.state === 'recording';
  $('cameraButton').hidden = !!stream;
  $('cameraButton').disabled = busy || cameraStarting;
  $('recordButton').hidden = !stream || recording;
  $('recordButton').disabled = !stream || busy;
  $('stopButton').hidden = !recording;
  $('cameraOffButton').hidden = !stream;
  $('cameraOffButton').disabled = recording;
  $('saveButton').disabled = !clip || busy;
  $('useRecordingButton').hidden = !clip;
  $('evalButton').disabled = busy || !$('evalFiles').files.length;
  $('sampleFile').disabled = busy; $('evalFiles').disabled = busy;
  $('trackButton').disabled = cameraStarting;
  $('cameraState').textContent = t(stream ? 'cameraOn' : 'cameraOff');
  $('cameraState').classList.toggle('connected', !!stream);
  $('clipStatus').textContent = t(clip ? 'recordingAvailable' : 'noRecording');
}
function renderTracking() {
  $('trackButton').setAttribute('aria-pressed', String(tracker.active));
  $('trackButtonText').textContent = t(tracker.active ? 'hideJoints' : 'checkJoints');
  $('trackingInfo').hidden = !trackState;
  $('trackingInfo').classList.toggle('error', !!trackState?.error);
  $('trackStatus').textContent = trackState ? t(trackState.key) : '';
  $('trackingStats').textContent = trackState?.hands !== undefined ? t('trackingStats', {hands: trackState.hands, fps: trackState.fps}) : '';
}
async function startCamera() {
  if (stream) return true;
  if (cameraStarting) return false;
  const request = ++cameraRequest; cameraStarting = true; renderControls();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), {name: 'UnsupportedCamera'});
    const acquired = await navigator.mediaDevices.getUserMedia({video: {width: {ideal: 960}, height: {ideal: 720}}, audio: false});
    if (request !== cameraRequest) { acquired.getTracks().forEach(track => track.stop()); return false; }
    stream = acquired;
    $('preview').srcObject = stream; $('placeholder').hidden = true;
    await $('preview').play();
    stream.getVideoTracks()[0].addEventListener('ended', stopCamera);
    setFeedback('');
    return true;
  } catch (error) {
    stopCamera();
    const key = {NotAllowedError:'cameraDenied',NotFoundError:'cameraMissing',NotReadableError:'cameraBusy',UnsupportedCamera:'cameraUnsupported'}[error.name] || 'cameraFailed';
    setFeedback(t(key), true); return false;
  } finally { cameraStarting = false; renderControls(); }
}
function stopCamera() {
  cameraRequest += 1;
  if (recorder?.state === 'recording') recorder.stop();
  tracker.stop(); trackState = null; renderTracking();
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null; $('preview').srcObject = null; $('placeholder').hidden = false;
  renderControls();
}
function setPanel(name) {
  if (recorder?.state === 'recording') { setFeedback(t('finishRecordingFirst')); return; }
  if (name !== 'studio') stopCamera();
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
  document.querySelectorAll('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === name; button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
}
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => setPanel(button.dataset.tab));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => setPanel(button.dataset.go));
$('phraseSelect').addEventListener('change', renderCatalog);
$('useRecordingButton').onclick = () => setPanel('dataset');
$('cameraButton').addEventListener('click', startCamera);
$('cameraOffButton').addEventListener('click', stopCamera);
$('trackButton').addEventListener('click', async () => {
  if (tracker.active) { tracker.stop(); trackState = null; renderTracking(); return; }
  if (await startCamera()) tracker.start();
});
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) { tracker.stop(); trackState = null; renderTracking(); } });
$('recordButton').addEventListener('click', () => {
  if (!stream || busy) return;
  if (tracker.active) { tracker.stop(); trackState = null; renderTracking(); }
  if (!window.MediaRecorder) { setFeedback(t('unsupportedRecording'), true); return; }
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) { setFeedback(t('unsupportedRecording')); return; }
  chunks = []; clip = null; $('saveButton').disabled = true; startedAt = Date.now();
  try { recorder = new MediaRecorder(stream, {mimeType: mime}); }
  catch (_) { setFeedback(t('unsupportedRecording'), true); renderControls(); return; }
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = async () => {
    clip = new Blob(chunks, {type: mime}); $('saveButton').disabled = false;
    $('recordBadge').classList.remove('visible'); clearInterval(timerId);
    busy = true; renderControls();
    resultState = {phase: 'processing'}; renderResult();
    try {
      const sequence = await window.GestureEngine.extract(clip);
      const prediction = await api('/api/recognize', {sequence});
      resultState = {phase: prediction.phrase_id ? 'recognized' : 'unknown', prediction}; renderResult();
    } catch (error) { resultState = {phase: 'error', error: error.message}; renderResult(); }
    finally { busy = false; renderControls(); }
  };
  try { recorder.start(); }
  catch (_) { setFeedback(t('unsupportedRecording'), true); renderControls(); return; }
  $('timer').textContent = '0:00'; $('recordBadge').classList.add('visible'); renderControls();
  timerId = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (seconds >= 8) $('stopButton').click();
  }, 200);
});
$('stopButton').addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });
$('saveButton').addEventListener('click', async () => {
  if (!clip || busy) return;
  busy = true; renderControls();
  try { setFeedback(t('saving')); const sequence = await window.GestureEngine.extract(clip); const data = await api('/api/samples', {phrase_id: $('phraseSelect').value, sequence}); counts = data.counts; renderCatalog(); setFeedback(t('saved', {n: data.frames})); }
  catch (error) { setFeedback(error.message, true); }
  finally { busy = false; renderControls(); }
});
$('sampleFile').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  busy = true; renderControls();
  try { setFeedback(t('uploading')); const sequence = await window.GestureEngine.extract(file); const data = await api('/api/samples', {phrase_id: $('phraseSelect').value, sequence}); counts = data.counts; renderCatalog(); setFeedback(t('uploaded', {n: data.frames})); }
  catch (error) { setFeedback(error.message, true); }
  finally { event.target.value = ''; busy = false; renderControls(); }
});
$('evalFiles').addEventListener('change', event => {
  $('evalLabels').replaceChildren(...Array.from(event.target.files).map((file, index) => {
    const row = document.createElement('div'); row.className = 'eval-line';
    const name = document.createElement('span'); name.textContent = file.name;
    const select = document.createElement('select'); select.dataset.index = index; select.setAttribute('aria-label', file.name);
    options(select, true); row.append(name, select); return row;
  }));
  renderControls(); evalState = {phase: 'idle'}; renderEvaluation();
});
$('evalButton').addEventListener('click', async () => {
  if (busy) return;
  const files = Array.from($('evalFiles').files); if (!files.length) { evalState = {phase: 'error', error: t('noVideos')}; renderEvaluation(); return; }
  busy = true; renderControls(); evalState = {phase: 'loading'}; renderEvaluation();
  try {
    const items = [];
    for (const [index, file] of files.entries()) items.push({file: file.name, expected: $('evalLabels').querySelector(`select[data-index="${index}"]`).value, sequence: await window.GestureEngine.extract(file)});
    evalState = {phase: 'done', data: await api('/api/evaluate', {items})};
  }
  catch (error) { evalState = {phase: 'error', error: error.message}; }
  busy = false; renderControls(); renderEvaluation();
});
applyLocale(); renderControls(); refresh().catch(error => setFeedback(error.message, true));
if (new URLSearchParams(location.search).has('mediaTest')) {
  setFeedback('Loading MediaPipe…');
  window.GestureEngine.ready().then(() => setFeedback('MediaPipe ready')).catch(error => setFeedback(error.message, true));
}
