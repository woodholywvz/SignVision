const $ = (id) => document.getElementById(id);
const translations = window.SIGNVISION_I18N;
const initialQuery = new URLSearchParams(location.search).get('lang');
let savedLanguage;
try {
  savedLanguage = localStorage.getItem('signvision.language');
} catch (_) {
  /* private browsing */
}
let locale = ['ru', 'en'].includes(initialQuery)
  ? initialQuery
  : ['ru', 'en'].includes(savedLanguage)
    ? savedLanguage
    : (navigator.language || 'ru').toLowerCase().startsWith('ru')
      ? 'ru'
      : 'en';
let stream,
  recorder,
  chunks = [],
  clip,
  startedAt,
  timerId,
  phrases = [],
  counts = {};
let resultState = { phase: 'waiting' },
  feedback = '',
  evalState = { phase: 'idle' };
let evaluationController = null;
let phraseDeletion = null;
let busy = false,
  cameraStarting = false,
  cameraRequest = 0;
let trackState = null;
let configLoading = true;
let catalogLoaded = false;
let configError = null;
let liveRequest = null;
let live = false,
  liveFrames = [],
  liveQuality = {},
  liveSentAt = 0,
  liveFrameAt = 0,
  livePending = false,
  liveGeneration = 0;
const tracker = new window.LiveTracking($('preview'), $('landmarkOverlay'), (state) => {
  trackState = state;
  if (state.error && live) {
    stopLive();
    resultState = { phase: 'error', error: t(state.key) };
    renderResult();
  } else if (live && resultState.phase === 'starting') {
    renderResult();
  }
  renderTracking();
});
const t = (key, values = {}) =>
  (translations[locale][key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const errorText = (error) =>
  [
    'videoTooLong',
    'videoReadTimeout',
    'videoUnreadable',
    'videoDurationUnreadable',
    'evaluationCancelled',
    'evaluationRequestTimeout',
  ].includes(error.message)
    ? t(error.message)
    : error.message;
function countText(number, kind) {
  const category = new Intl.PluralRules(locale).select(number);
  const ending = category === 'one' ? 'One' : category === 'few' ? 'Few' : 'Many';
  return `${number} ${t(kind + ending)}`;
}
const phraseName = (id) =>
  id === 'unknown'
    ? t('unknown')
    : (() => {
        const phrase = phrases.find((item) => item.id === id);
        return phrase ? (locale === 'en' ? phrase.en || phrase.text : phrase.text) : id;
      })();

async function api(url, data, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Accept-Language': locale, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw Error(typeof payload.detail === 'string' ? payload.detail : t('requestFailed'));
  }
  return payload;
}
function options(select, includeUnknown = false, selected) {
  select.replaceChildren(
    ...phrases.map((phrase) => {
      const option = document.createElement('option');
      option.value = phrase.id;
      option.textContent = phraseName(phrase.id);
      return option;
    }),
  );
  if (includeUnknown) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('evalSelectLabel');
    select.prepend(placeholder);
    const option = document.createElement('option');
    option.value = 'unknown';
    option.textContent = t('unknown');
    select.append(option);
  }
  if (selected && Array.from(select.options).some((option) => option.value === selected)) {
    select.value = selected;
  } else if (includeUnknown) {
    select.value = '';
  }
}
function renderCatalog() {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  $('datasetStatus').textContent = t('datasetCount', { count: countText(total, 'example') });
  $('totalCount').textContent = countText(total, 'example');
  renderHomeStatus();
  $('phraseGrid').replaceChildren(
    ...phrases.map((phrase, index) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'phrase-card';
      card.classList.toggle('selected', $('phraseSelect').value === phrase.id);
      card.setAttribute('aria-pressed', String($('phraseSelect').value === phrase.id));
      card.onclick = () => {
        $('phraseSelect').value = phrase.id;
        renderCatalog();
      };
      const number = document.createElement('span');
      number.className = 'card-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('strong');
      title.textContent = phraseName(phrase.id);
      const count = document.createElement('small');
      count.textContent = countText(counts[phrase.id] || 0, 'recording');
      card.append(number, title, count);
      if (!window.SignVisionLearning?.isAdmin()) {
        return card;
      }
      const row = document.createElement('div');
      row.className = 'dictionary-row';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button quiet dictionary-delete';
      remove.textContent = t('deletePhrase');
      remove.setAttribute('aria-label', t('deletePhraseNamed', { phrase: phraseName(phrase.id) }));
      remove.disabled = !!phraseDeletion?.pending;
      remove.onclick = () => {
        phraseDeletion = { id: phrase.id, name: phraseName(phrase.id), pending: false, error: '' };
        $('phraseDeleteStatus').textContent = '';
        renderPhraseDeletion();
        $('confirmDeletePhraseButton').focus();
      };
      row.append(card, remove);
      return row;
    }),
  );
  renderPhraseDeletion();
}
function renderPhraseDeletion() {
  $('phraseDeletePrompt').hidden = !phraseDeletion || !window.SignVisionLearning?.isAdmin();
  if (!phraseDeletion) {
    return;
  }
  $('phraseDeleteTitle').textContent = t('confirmDeletePhrase', { phrase: phraseDeletion.name });
  $('phraseDeleteError').textContent = phraseDeletion.error;
  $('confirmDeletePhraseButton').disabled = phraseDeletion.pending;
  $('confirmDeletePhraseButton').textContent = t(
    phraseDeletion.pending ? 'deletingPhrase' : 'deletePhrase',
  );
  $('cancelDeletePhraseButton').disabled = phraseDeletion.pending;
}
async function deleteDictionaryPhrase() {
  if (!phraseDeletion || phraseDeletion.pending || !window.SignVisionLearning?.isAdmin()) {
    return;
  }
  const deletion = phraseDeletion;
  deletion.pending = true;
  deletion.error = '';
  renderCatalog();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(t('phraseDeleteTimeout'))), 15000);
  try {
    const response = await fetch(`/api/admin/phrases/${encodeURIComponent(deletion.id)}`, {
      method: 'DELETE',
      headers: { 'Accept-Language': locale },
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || t('requestFailed'));
    }
    phrases = data.phrases;
    counts = data.counts;
    phraseDeletion = null;
    applyLocale();
    renderCatalog();
    $('phraseDeleteStatus').textContent = t('phraseDeleted', { phrase: deletion.name });
    await Promise.allSettled([
      window.SignVisionLearning.refreshLessons(),
      window.SignVisionLearning.loadAdmin(),
    ]);
  } catch (error) {
    deletion.pending = false;
    deletion.error = error.message;
    renderCatalog();
  } finally {
    clearTimeout(timeout);
  }
}
function renderHomeStatus() {
  const ready = Object.values(counts).some(Boolean);
  $('homeStatus').textContent = t(ready ? 'homeReady' : 'homeNeedsExamples');
  $('homeStatusDetail').textContent = t(ready ? 'homeReadyDetail' : 'homeNeedsExamplesDetail');
  $('homeTranslateButton').textContent = t(
    ready
      ? 'homeOpenTranslator'
      : window.SignVisionLearning?.isAdmin()
        ? 'homeAddExamples'
        : 'homeExploreLessons',
  );
  $('homeTranslateButton').dataset.go = ready
    ? 'studio'
    : window.SignVisionLearning?.isAdmin()
      ? 'dataset'
      : 'lessons';
  $('homeTranslateButton').onclick = () => setPanel($('homeTranslateButton').dataset.go);
  $('homeStatus').closest('.home-readiness').classList.toggle('needs-examples', !ready);
}
function renderResult() {
  const { prediction, error } = resultState;
  const noExamples = catalogLoaded && !Object.values(counts).some(Boolean);
  const phase = resultState.phase === 'waiting' && noExamples ? 'empty' : resultState.phase;
  $('result').classList.toggle('is-unknown', phase === 'unknown' || phase === 'error');
  $('result').classList.toggle('is-tentative', phase === 'tentative');
  const caption =
    phase === 'starting'
      ? 'liveStarting'
      : phase === 'empty'
        ? 'emptyDatasetState'
        : phase === 'tentative'
          ? 'tentativeState'
          : phase === 'listening'
            ? 'liveState'
            : phase === 'recognized'
              ? 'recognized'
              : phase === 'unknown'
                ? 'unknownState'
                : phase === 'processing'
                  ? 'processing'
                  : phase === 'error'
                    ? 'errorState'
                    : 'waiting';
  $('resultCaption').textContent = t(caption);
  const action = $('resultActionButton');
  action.hidden = phase !== 'empty';
  action.textContent = t(
    window.SignVisionLearning?.isAdmin() ? 'addReferencesAction' : 'browseLessonsAction',
  );
  if (phase === 'empty') {
    $('resultText').textContent = t('liveEmpty');
    $('resultDetail').textContent = t(
      window.SignVisionLearning?.isAdmin() ? 'liveEmptyHint' : 'liveEmptyStudentHint',
    );
  } else if (phase === 'starting') {
    $('resultText').textContent = t('liveStarting');
    $('resultDetail').textContent = t(trackState?.key || 'trackingLoading');
  } else if (phase === 'listening') {
    $('resultText').textContent = t('liveListening');
    $('resultDetail').textContent = prediction?.advice_code
      ? t('advice_' + prediction.advice_code)
      : t('liveListeningHint');
  } else if (phase === 'tentative') {
    $('resultText').textContent = prediction.alternative_id
      ? t('maybePhrases', {
          first: phraseName(prediction.candidate_id),
          second: phraseName(prediction.alternative_id),
        })
      : t('maybePhrase', { phrase: phraseName(prediction.candidate_id) });
    $('resultDetail').textContent = t('advice_' + prediction.advice_code);
  } else if (phase === 'processing') {
    $('resultText').textContent = t('analyzing');
    $('resultDetail').textContent = '';
  } else if (phase === 'error') {
    $('resultText').textContent = t('failedRecognize');
    $('resultDetail').textContent = error;
  } else if (prediction) {
    $('resultText').textContent = phraseName(prediction.phrase_id || 'unknown');
    if (prediction.advice_code) {
      $('resultDetail').textContent = t('advice_' + prediction.advice_code);
      return;
    }
    if (live) {
      $('resultDetail').textContent =
        phase === 'unknown' ? t('liveUnknownHint') : t('liveRecognizedHint');
      return;
    }
    const reasonKey =
      prediction.reason_code === 'recognized' ? 'recognizedReason' : prediction.reason_code;
    const details = [t(reasonKey), t('frames', { n: prediction.frames })];
    if (prediction.distance !== null) {
      details.push(t('distance', { n: prediction.distance.toFixed(3) }));
    }
    $('resultDetail').textContent = details.join(' · ');
  } else {
    $('resultText').textContent = t('resultPlaceholder');
    $('resultDetail').textContent = t('resultHint');
  }
}
function renderEvaluation() {
  const container = $('evalResult');
  container.replaceChildren();
  if (evalState.phase === 'loading') {
    const progress = document.createElement('p');
    progress.textContent = t('evaluationProgress', {
      done: evalState.completed,
      total: evalState.total,
      file: evalState.file || '',
    });
    container.append(progress);
  }
  if (evalState.phase === 'error') {
    container.textContent = evalState.error;
    return;
  }
  if (!evalState.data) {
    return;
  }
  const data = evalState.data;
  const summary = document.createElement('span');
  summary.className = 'eval-summary';
  summary.textContent = data.evaluated
    ? t('accuracy', {
        correct: data.correct,
        total: data.evaluated,
        percent: Math.round(data.accuracy * 100),
      })
    : t('evaluationNoValid');
  const coverage = document.createElement('p');
  coverage.textContent = t('evaluationCoverage', {
    evaluated: data.evaluated,
    total: data.total,
    failed: data.failed,
  });
  const explanation = document.createElement('p');
  explanation.textContent = t(
    evalState.phase === 'cancelled' ? 'evaluationCancelled' : 'evaluationScoring',
  );
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['file', 'expected', 'predicted', 'outcome', 'evaluationDetails'].forEach((key) => {
    const th = document.createElement('th');
    th.textContent = t(key);
    headerRow.append(th);
  });
  head.append(headerRow);
  table.append(head);
  const body = document.createElement('tbody');
  data.results.forEach((row) => {
    const tr = document.createElement('tr');
    [
      row.file,
      phraseName(row.expected),
      row.predicted ? phraseName(row.predicted) : t('evaluationProcessingError'),
      row.status === 'error' ? '—' : row.correct ? '✓' : '✕',
      row.status === 'error'
        ? row.error
        : [
            row.alternative_id
              ? t('maybePhrases', {
                  first: phraseName(row.candidate_id),
                  second: phraseName(row.alternative_id),
                })
              : row.candidate_id
                ? t('maybePhrase', { phrase: phraseName(row.candidate_id) })
                : '',
            row.advice_code ? t('advice_' + row.advice_code) : '',
          ]
            .filter(Boolean)
            .join(' '),
    ].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  container.append(summary, coverage, explanation, table);
}
function applyLocale() {
  document.documentElement.lang = locale;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document
    .querySelectorAll('[data-i18n-aria-label]')
    .forEach((element) => element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel)));
  document
    .querySelectorAll('.lang-switch button')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.lang === locale)),
    );
  $('cameraState').textContent = t(stream ? 'cameraOn' : 'cameraOff');
  $('cameraState').classList.toggle('connected', !!stream);
  const selected = $('phraseSelect').value;
  options($('phraseSelect'), false, selected);
  document
    .querySelectorAll('#evalLabels select')
    .forEach((select) => options(select, true, select.value));
  if (catalogLoaded) {
    renderCatalog();
  } else {
    $('datasetStatus').textContent = t('loadingDataset');
    $('homeStatus').textContent = t('homeLoading');
    $('homeStatusDetail').textContent = '';
  }
  $('clipStatus').textContent = t(clip ? 'recordingAvailable' : 'noRecording');
  $('feedback').textContent = feedback;
  renderResult();
  renderEvaluation();
  renderTracking();
  renderControls();
  window.SignVisionLearning?.render();
}
document.querySelectorAll('.lang-switch button').forEach((button) =>
  button.addEventListener('click', () => {
    locale = button.dataset.lang;
    try {
      localStorage.setItem('signvision.language', locale);
    } catch (_) {
      /* private browsing */
    }
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set('lang', locale);
    history.replaceState(null, '', nextUrl);
    applyLocale();
  }),
);
async function refresh() {
  configLoading = true;
  renderControls();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(t('referencesTimeout'))), 15000);
  try {
    const response = await fetch('/api/config', { signal: controller.signal });
    if (!response.ok) {
      throw Error(t('requestFailed'));
    }
    const config = await response.json();
    phrases = config.phrases;
    counts = config.counts;
    catalogLoaded = true;
    configError = null;
    applyLocale();
  } catch (error) {
    configError = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    configLoading = false;
    renderControls();
  }
}
function setFeedback(text, error = false) {
  feedback = text;
  $('feedback').textContent = text;
  $('feedback').classList.toggle('error', error);
}
function renderControls() {
  const recording = recorder?.state === 'recording';
  $('cameraButton').hidden = !!stream;
  $('cameraButton').disabled = busy || cameraStarting;
  $('recordButton').hidden = !stream || recording;
  $('recordButton').disabled = !stream || busy || live;
  $('liveButton').disabled =
    configLoading ||
    busy ||
    recording ||
    cameraStarting ||
    (catalogLoaded && !Object.values(counts).some(Boolean));
  $('liveButton').setAttribute('aria-pressed', String(live));
  $('liveButton').textContent = t(
    configLoading && !live ? 'loadingReferences' : live ? 'stopLive' : 'startLive',
  );
  $('stopButton').hidden = !recording;
  $('cameraOffButton').hidden = !stream;
  $('cameraOffButton').disabled = recording;
  $('saveButton').disabled = !clip || busy || !window.SignVisionLearning?.isAdmin();
  $('useRecordingButton').hidden = !clip || !window.SignVisionLearning?.isAdmin();
  const evalSelects = Array.from($('evalLabels').querySelectorAll('select'));
  $('evalButton').disabled =
    busy ||
    configLoading ||
    !$('evalFiles').files.length ||
    !evalSelects.length ||
    evalSelects.some((select) => !select.value);
  $('evalCancelButton').hidden = !evaluationController;
  evalSelects.forEach((select) => {
    select.disabled = busy;
  });
  $('sampleFile').disabled = busy || !window.SignVisionLearning?.isAdmin();
  $('evalFiles').disabled = busy;
  $('trackButton').disabled = busy || cameraStarting || live;
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
  $('trackingStats').textContent =
    trackState?.hands !== undefined
      ? t('trackingStats', { hands: trackState.hands, fps: trackState.fps })
      : '';
}
async function startCamera() {
  if (stream) {
    return true;
  }
  if (cameraStarting) {
    return false;
  }
  const request = ++cameraRequest;
  cameraStarting = true;
  renderControls();
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error(), { name: 'UnsupportedCamera' });
    }
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
      audio: false,
    });
    if (request !== cameraRequest) {
      acquired.getTracks().forEach((track) => track.stop());
      return false;
    }
    stream = acquired;
    $('preview').srcObject = stream;
    $('placeholder').hidden = true;
    await $('preview').play();
    stream.getVideoTracks()[0].addEventListener('ended', stopCamera);
    setFeedback('');
    window.SignVisionSounds?.play('camera');
    return true;
  } catch (error) {
    stopCamera();
    const key =
      {
        NotAllowedError: 'cameraDenied',
        NotFoundError: 'cameraMissing',
        NotReadableError: 'cameraBusy',
        UnsupportedCamera: 'cameraUnsupported',
      }[error.name] || 'cameraFailed';
    setFeedback(t(key), true);
    resultState = { phase: 'error', error: t(key) };
    renderResult();
    window.SignVisionSounds?.play('cameraError');
    return false;
  } finally {
    cameraStarting = false;
    renderControls();
  }
}
function stopCamera() {
  cameraRequest += 1;
  stopLive();
  if (recorder?.state === 'recording') {
    recorder.stop();
  }
  tracker.stop();
  trackState = null;
  renderTracking();
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  stream = null;
  $('preview').srcObject = null;
  $('placeholder').hidden = false;
  renderControls();
}
function setPanel(name, fromHistory = false) {
  if (recorder?.state === 'recording') {
    setFeedback(t('finishRecordingFirst'));
    return;
  }
  if (!['home', 'studio', 'dataset', 'lessons', 'evaluation', 'admin', 'account'].includes(name)) {
    name = 'home';
  }
  if (name === 'admin' && !window.SignVisionLearning?.isAdmin()) {
    name = 'account';
  }
  const current = document.querySelector('[data-panel]:not([hidden])')?.dataset.panel;
  if (name !== 'studio') {
    stopCamera();
  }
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === name;
    button.classList.toggle('active', selected);
    if (selected) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  window.SignVisionLearning?.onPanel(name);
  if (current !== name) {
    if (!fromHistory) {
      const url = new URL(location.href);
      if (name === 'home') {
        url.searchParams.delete('tab');
      } else {
        url.searchParams.set('tab', name);
      }
      history.pushState(null, '', url);
    }
    window.scrollTo(0, 0);
  }
}
document
  .querySelectorAll('[data-tab]')
  .forEach((button) => (button.onclick = () => setPanel(button.dataset.tab)));
document
  .querySelectorAll('[data-go]')
  .forEach((button) => (button.onclick = () => setPanel(button.dataset.go)));
$('homeTrackButton').onclick = () => {
  setPanel('studio');
  $('trackButton').click();
};
$('signInLink').onclick = (event) => {
  event.preventDefault();
  setPanel('account');
};
window.addEventListener('popstate', () =>
  setPanel(new URLSearchParams(location.search).get('tab') || 'home', true),
);
$('phraseSelect').addEventListener('change', renderCatalog);
$('confirmDeletePhraseButton').addEventListener('click', deleteDictionaryPhrase);
$('cancelDeletePhraseButton').addEventListener('click', () => {
  if (phraseDeletion?.pending) {
    return;
  }
  phraseDeletion = null;
  renderCatalog();
});
$('newPhraseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('addPhraseButton');
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  try {
    const created = await api('/api/admin/phrases', {
      text: $('newPhraseRu').value,
      en: $('newPhraseEn').value,
    });
    await refresh();
    $('phraseSelect').value = created.phrase.id;
    renderCatalog();
    await window.SignVisionLearning?.refreshLessons();
    await window.SignVisionLearning?.loadAdmin();
    $('newPhraseRu').value = '';
    $('newPhraseEn').value = '';
    $('phraseCreate').open = false;
    setFeedback(t('phraseCreated', { phrase: phraseName(created.phrase.id) }));
  } catch (caught) {
    setFeedback(caught.message, true);
  } finally {
    button.disabled = false;
  }
});
$('useRecordingButton').onclick = () => setPanel('dataset');
$('resultActionButton').onclick = () =>
  setPanel(window.SignVisionLearning?.isAdmin() ? 'dataset' : 'lessons');
$('cameraButton').addEventListener('click', startCamera);
$('cameraOffButton').addEventListener('click', stopCamera);
$('trackButton').addEventListener('click', async () => {
  if (tracker.active) {
    tracker.stop();
    trackState = null;
    renderTracking();
    return;
  }
  if (await startCamera()) {
    tracker.start();
  }
});
function stopLive() {
  live = false;
  liveGeneration++;
  liveRequest?.abort();
  liveRequest = null;
  liveFrames = [];
  livePending = false;
  tracker.onFrame = null;
  renderControls();
}
tracker.onFrame = null;
function liveFrame(frame, now, quality) {
  if (!live || now - liveFrameAt < 125) {
    return;
  }
  liveFrameAt = now;
  if (resultState.phase === 'starting') {
    resultState = { phase: 'listening' };
    renderResult();
  }
  liveFrames.push({ frame, at: now });
  while (liveFrames.length > 72 || (liveFrames.length && now - liveFrames[0].at > 8500)) {
    liveFrames.shift();
  }
  if (quality) {
    liveQuality = quality;
  }
  if (liveFrames.length < 12 || livePending || now - liveSentAt < 1250) {
    return;
  }
  liveSentAt = now;
  livePending = true;
  const generation = liveGeneration;
  const controller = new AbortController();
  liveRequest = controller;
  const timeout = setTimeout(() => controller.abort(new Error(t('liveRequestTimeout'))), 12000);
  const duration_s = (now - liveFrames[0].at) / 1000;
  api(
    '/api/live',
    {
      sequence: liveFrames.map((item) => item.frame),
      duration_s,
      quality: liveQuality,
    },
    controller.signal,
  )
    .then((prediction) => {
      if (!live || generation !== liveGeneration) {
        return;
      }
      resultState = {
        phase:
          prediction.state === 'waiting'
            ? 'listening'
            : prediction.state === 'empty_dataset'
              ? 'empty'
              : prediction.state,
        prediction,
      };
      renderResult();
    })
    .catch((error) => {
      if (live && generation === liveGeneration) {
        resultState = { phase: 'error', error: error.message };
        renderResult();
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      if (generation === liveGeneration) {
        livePending = false;
        liveRequest = null;
      }
    });
}
$('liveButton').addEventListener('click', async () => {
  if (live) {
    stopLive();
    tracker.stop();
    trackState = null;
    resultState = { phase: 'waiting' };
    renderResult();
    renderTracking();
    return;
  }
  if (configError) {
    resultState = { phase: 'starting' };
    renderResult();
    try {
      await refresh();
    } catch (error) {
      resultState = { phase: 'error', error: error.message };
      renderResult();
      return;
    }
  }
  if (!Object.values(counts).some(Boolean)) {
    resultState = { phase: 'empty' };
    renderResult();
    return;
  }
  if (!(await startCamera())) {
    return;
  }
  live = true;
  liveGeneration++;
  liveFrames = [];
  liveQuality = {};
  liveSentAt = 0;
  liveFrameAt = 0;
  tracker.onFrame = liveFrame;
  resultState = { phase: tracker.active ? 'listening' : 'starting' };
  renderResult();
  renderControls();
  if (!tracker.active) {
    tracker.start();
  }
});
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopLive();
    tracker.stop();
    trackState = null;
    renderTracking();
  }
});
$('recordButton').addEventListener('click', () => {
  if (!stream || busy) {
    return;
  }
  if (!window.MediaRecorder) {
    setFeedback(t('unsupportedRecording'), true);
    return;
  }
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!mime) {
    setFeedback(t('unsupportedRecording'));
    return;
  }
  chunks = [];
  clip = null;
  $('saveButton').disabled = true;
  startedAt = Date.now();
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (_) {
    setFeedback(t('unsupportedRecording'), true);
    renderControls();
    return;
  }
  recorder.ondataavailable = (event) => {
    if (event.data.size) {
      chunks.push(event.data);
    }
  };
  recorder.onstop = async () => {
    clip = new Blob(chunks, { type: mime });
    $('saveButton').disabled = false;
    $('recordBadge').classList.remove('visible');
    clearInterval(timerId);
    busy = true;
    renderControls();
    resultState = { phase: 'processing' };
    renderResult();
    try {
      const analysis = await window.GestureEngine.analyze(clip);
      const practicePhrase = window.SignVisionLearning?.practicePhrase;
      const practice = practicePhrase
        ? await api(`/api/lessons/${practicePhrase}/practice`, analysis)
        : null;
      const prediction = practice?.prediction || (await api('/api/recognize', analysis));
      resultState = {
        phase:
          prediction.state === 'empty_dataset'
            ? 'empty'
            : prediction.state || (prediction.phrase_id ? 'recognized' : 'unknown'),
        prediction,
      };
      renderResult();
      if (practice) {
        await window.SignVisionLearning.onPracticeResult(practice);
      }
    } catch (error) {
      resultState = { phase: 'error', error: errorText(error) };
      renderResult();
    } finally {
      busy = false;
      renderControls();
    }
  };
  try {
    recorder.start();
  } catch (_) {
    setFeedback(t('unsupportedRecording'), true);
    renderControls();
    return;
  }
  $('timer').textContent = '0:00';
  $('recordBadge').classList.add('visible');
  renderControls();
  timerId = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (seconds >= 8) {
      $('stopButton').click();
    }
  }, 200);
});
$('stopButton').addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    recorder.stop();
  }
});
$('saveButton').addEventListener('click', async () => {
  if (!clip || busy) {
    return;
  }
  busy = true;
  renderControls();
  try {
    setFeedback(t('saving'));
    const sequence = await window.GestureEngine.extract(clip);
    const data = await api('/api/samples', {
      phrase_id: $('phraseSelect').value,
      sequence,
      duration_s: sequence.length / 8,
    });
    counts = data.counts;
    renderCatalog();
    await window.SignVisionLearning?.refreshLessons();
    await window.SignVisionLearning?.loadAdmin();
    setFeedback(t('saved', { n: data.frames }));
  } catch (error) {
    setFeedback(errorText(error), true);
  } finally {
    busy = false;
    renderControls();
  }
});
$('sampleFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file || busy) {
    return;
  }
  busy = true;
  renderControls();
  try {
    setFeedback(t('uploading'));
    const sequence = await window.GestureEngine.extract(file);
    const data = await api('/api/samples', {
      phrase_id: $('phraseSelect').value,
      sequence,
      duration_s: sequence.length / 8,
    });
    counts = data.counts;
    renderCatalog();
    await window.SignVisionLearning?.refreshLessons();
    await window.SignVisionLearning?.loadAdmin();
    setFeedback(t('uploaded', { n: data.frames }));
  } catch (error) {
    setFeedback(errorText(error), true);
  } finally {
    event.target.value = '';
    busy = false;
    renderControls();
  }
});
$('evalFiles').addEventListener('change', (event) => {
  if (event.target.files.length > 30) {
    event.target.value = '';
    $('evalLabels').replaceChildren();
    evalState = { phase: 'error', error: t('evaluationLimit') };
    renderEvaluation();
    renderControls();
    return;
  }
  $('evalLabels').replaceChildren(
    ...Array.from(event.target.files).map((file, index) => {
      const row = document.createElement('div');
      row.className = 'eval-line';
      const name = document.createElement('span');
      name.textContent = file.name;
      const select = document.createElement('select');
      select.dataset.index = index;
      select.setAttribute('aria-label', file.name);
      options(select, true);
      select.addEventListener('change', renderControls);
      row.append(name, select);
      return row;
    }),
  );
  renderControls();
  evalState = { phase: 'idle' };
  renderEvaluation();
});
function evaluationSummary(results, total) {
  const evaluated = results.filter((row) => row.status === 'evaluated').length;
  const correct = results.filter((row) => row.correct === true).length;
  return {
    results,
    total,
    evaluated,
    correct,
    failed: results.filter((row) => row.status === 'error').length,
    accuracy: evaluated ? correct / evaluated : null,
  };
}
async function runEvaluation() {
  if (busy) {
    return;
  }
  const files = Array.from($('evalFiles').files);
  if (!files.length) {
    evalState = { phase: 'error', error: t('noVideos') };
    renderEvaluation();
    return;
  }
  const labels = files.map(
    (_, index) => $('evalLabels').querySelector(`select[data-index="${index}"]`)?.value,
  );
  if (labels.some((label) => !label)) {
    evalState = { phase: 'error', error: t('evalSelectLabel') };
    renderEvaluation();
    return;
  }
  if (!Object.values(counts).some(Boolean)) {
    evalState = { phase: 'error', error: t('evaluationNeedsReferences') };
    renderEvaluation();
    return;
  }
  stopCamera();
  const controller = new AbortController();
  evaluationController = controller;
  busy = true;
  renderControls();
  const results = [];
  evalState = {
    phase: 'loading',
    completed: 0,
    total: files.length,
    data: evaluationSummary(results, files.length),
  };
  renderEvaluation();
  try {
    for (const [index, file] of files.entries()) {
      if (controller.signal.aborted) {
        break;
      }
      evalState.file = file.name;
      renderEvaluation();
      try {
        const analysis = await window.GestureEngine.analyze(file, { signal: controller.signal });
        const requestController = new AbortController();
        const cancelRequest = () => requestController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelRequest, { once: true });
        const timeout = setTimeout(
          () => requestController.abort(new Error('evaluationRequestTimeout')),
          20000,
        );
        try {
          if (controller.signal.aborted) {
            cancelRequest();
          }
          const data = await api(
            '/api/evaluate',
            { items: [{ file: file.name, expected: labels[index], ...analysis }] },
            requestController.signal,
          );
          results.push(data.results[0]);
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', cancelRequest);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }
        results.push({
          file: file.name,
          expected: labels[index],
          predicted: null,
          correct: null,
          status: 'error',
          error: errorText(error),
        });
      }
      evalState.completed = results.length;
      evalState.data = evaluationSummary(results, files.length);
      renderEvaluation();
    }
    evalState.phase = controller.signal.aborted ? 'cancelled' : 'done';
  } finally {
    evaluationController = null;
    busy = false;
    renderControls();
    renderEvaluation();
  }
}
$('evalButton').addEventListener('click', runEvaluation);
$('evalCancelButton').addEventListener('click', () =>
  evaluationController?.abort(new Error('evaluationCancelled')),
);
applyLocale();
window.SignVisionSounds?.init(t);
renderControls();
refresh().catch((error) => setFeedback(error.message, true));
window.SignVisionLearning.init().catch((error) => setFeedback(error.message, true));
if (new URLSearchParams(location.search).has('mediaTest')) {
  setFeedback('Loading MediaPipe…');
  window.GestureEngine.selfTest()
    .then((hands) => setFeedback(`MediaPipe ready · hands: ${hands}`, hands < 1))
    .catch((error) => setFeedback(error.message, true));
}
