const $ = id => document.getElementById(id);
const translations = window.SIGNVISION_I18N;
const initialQuery = new URLSearchParams(location.search).get('lang');
let savedLanguage;
try { savedLanguage = localStorage.getItem('signvision.language'); } catch (_) { /* private browsing */ }
let locale = ['ru', 'en'].includes(initialQuery) ? initialQuery :
  (['ru', 'en'].includes(savedLanguage) ? savedLanguage : (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en');
let stream, recorder, chunks = [], clip, startedAt, timerId, phrases = [], counts = {};
let resultState = {phase: 'waiting'}, feedback = '', evalState = {phase: 'idle'};
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
  const response = await fetch(url, {method: 'POST', headers: {'Accept-Language': locale}, body: data});
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
    const card = document.createElement('div'); card.className = 'phrase-card';
    const number = document.createElement('span'); number.className = 'card-index'; number.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(phrases.length).padStart(2, '0');
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
  const selected = $('phraseSelect').value; options($('phraseSelect'), false, selected);
  document.querySelectorAll('#evalLabels select').forEach(select => options(select, true, select.value));
  if (phrases.length) renderCatalog(); else $('datasetStatus').textContent = t('loadingDataset');
  $('feedback').textContent = feedback; renderResult(); renderEvaluation();
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
function setFeedback(text) { feedback = text; $('feedback').textContent = text; }
$('cameraButton').addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {width: 960, height: 720}, audio: false});
    $('preview').srcObject = stream; $('placeholder').hidden = true;
    $('cameraState').textContent = t('cameraOn'); $('recordButton').disabled = false; $('cameraButton').hidden = true;
    setFeedback('');
  } catch (error) { setFeedback(t('cameraUnavailable', {error: error.message})); }
});
$('recordButton').addEventListener('click', () => {
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) { setFeedback(t('unsupportedRecording')); return; }
  chunks = []; clip = null; $('saveButton').disabled = true; startedAt = Date.now();
  recorder = new MediaRecorder(stream, {mimeType: mime});
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = async () => {
    clip = new Blob(chunks, {type: mime}); $('saveButton').disabled = false;
    $('recordBadge').classList.remove('visible'); clearInterval(timerId);
    $('stopButton').hidden = true; $('recordButton').hidden = false;
    const form = new FormData(); form.append('video', clip, `gesture.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
    resultState = {phase: 'processing'}; renderResult();
    try {
      const prediction = await api('/api/recognize', form);
      resultState = {phase: prediction.phrase_id ? 'recognized' : 'unknown', prediction}; renderResult();
    } catch (error) { resultState = {phase: 'error', error: error.message}; renderResult(); }
  };
  recorder.start(); $('recordBadge').classList.add('visible'); $('recordButton').hidden = true; $('stopButton').hidden = false;
  timerId = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (seconds >= 8) $('stopButton').click();
  }, 200);
});
$('stopButton').addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });
$('saveButton').addEventListener('click', async () => {
  if (!clip) return;
  const form = new FormData(); form.append('phrase_id', $('phraseSelect').value);
  form.append('video', clip, `sample.${clip.type.includes('mp4') ? 'mp4' : 'webm'}`);
  try { setFeedback(t('saving')); const data = await api('/api/samples', form); counts = data.counts; renderCatalog(); setFeedback(t('saved', {n: data.frames})); }
  catch (error) { setFeedback(error.message); }
});
$('sampleFile').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  const form = new FormData(); form.append('phrase_id', $('phraseSelect').value); form.append('video', file);
  try { setFeedback(t('uploading')); const data = await api('/api/samples', form); counts = data.counts; renderCatalog(); setFeedback(t('uploaded', {n: data.frames})); }
  catch (error) { setFeedback(error.message); }
  finally { event.target.value = ''; }
});
$('evalFiles').addEventListener('change', event => {
  $('evalLabels').replaceChildren(...Array.from(event.target.files).map((file, index) => {
    const row = document.createElement('div'); row.className = 'eval-line';
    const name = document.createElement('span'); name.textContent = file.name;
    const select = document.createElement('select'); select.dataset.index = index; select.setAttribute('aria-label', file.name);
    options(select, true); row.append(name, select); return row;
  }));
  $('evalButton').disabled = !event.target.files.length; evalState = {phase: 'idle'}; renderEvaluation();
});
$('evalButton').addEventListener('click', async () => {
  const files = Array.from($('evalFiles').files); if (!files.length) { evalState = {phase: 'error', error: t('noVideos')}; renderEvaluation(); return; }
  const form = new FormData(); files.forEach((file, index) => {
    form.append('videos', file); form.append('phrase_ids', $('evalLabels').querySelector(`select[data-index="${index}"]`).value);
  });
  evalState = {phase: 'loading'}; renderEvaluation();
  try { evalState = {phase: 'done', data: await api('/api/evaluate', form)}; }
  catch (error) { evalState = {phase: 'error', error: error.message}; }
  renderEvaluation();
});
applyLocale(); refresh().catch(error => setFeedback(error.message));
