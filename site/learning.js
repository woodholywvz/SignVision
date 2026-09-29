/* Account identity comes from Sites sign-in headers; this file only renders the UI. */
(function () {
  let theme;
  try { theme = localStorage.getItem('signvision.theme'); } catch (_) { /* private browsing */ }
  if (theme !== 'dark' && theme !== 'light') theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;

  const state = {me: null, lessons: [], completed: 0, total: 0, selected: null, users: [], samples: [], practicePhrase: null};
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const getJson = async path => {
    const response = await fetch(path);
    const data = await response.json();
    if (!response.ok) throw Error(data.detail || t('requestFailed'));
    return data;
  };
  const send = async (path, method, body, type) => {
    const response = await fetch(path, {method, headers: type ? {'content-type': type} : undefined, body});
    const data = await response.json();
    if (!response.ok) throw Error(data.detail || t('requestFailed'));
    return data;
  };
  const isAdmin = () => state.me?.account?.role === 'admin';
  const isRegistered = () => !!state.me?.registered;
  const currentLesson = () => state.lessons.find(lesson => lesson.phrase_id === state.selected);
  const lessonTitle = lesson => locale === 'en' ? lesson.title_en || lesson.title : lesson.title;

  function renderTheme() {
    $('themeButton').textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '◐';
    $('themeButton').setAttribute('aria-label', t(document.documentElement.dataset.theme === 'dark' ? 'lightTheme' : 'darkTheme'));
    $('themeButton').title = $('themeButton').getAttribute('aria-label');
  }
  function renderAccount() {
    const me = state.me;
    $('signInLink').hidden = !!me?.authenticated;
    $('accountButton').hidden = !me?.authenticated;
    $('accountButton').textContent = me?.account?.display_name || t('createProfile');
    document.querySelector('[data-tab="admin"]').hidden = !isAdmin();
    $('signOutLink').hidden = !me?.authenticated;
    $('registrationForm').hidden = !me?.authenticated || !!me?.registered;
    if (me?.authenticated && !me?.registered && !$('displayName').value) $('displayName').value = me.suggested_name || '';
    const content = $('accountContent'); content.replaceChildren();
    if (!me?.authenticated) {
      content.append(element('p', 'muted', t('accountSignInHint')));
      const link = element('a', 'button primary', t('signInChatGPT'));
      link.href = '/signin-with-chatgpt?return_to=%2F'; content.append(link);
    } else if (!me.registered) {
      content.append(element('p', 'muted', t('registerHint')));
    } else {
      content.append(element('strong', 'account-name', me.account.display_name));
      content.append(element('p', 'muted', me.account.email));
      content.append(element('p', 'role-label', t(me.account.role === 'admin' ? 'roleAdmin' : 'roleStudent')));
    }
    const admin = isAdmin();
    document.querySelector('.sample-panel').hidden = !admin;
    $('datasetReadOnly').hidden = admin;
    $('useRecordingButton').hidden = !admin || !clip;
    renderControls();
  }
  function renderLessons() {
    $('lessonProgressText').textContent = `${state.completed} / ${state.total || state.lessons.length}`;
    $('lessonProgressBar').style.width = `${state.total ? Math.round(state.completed / state.total * 100) : 0}%`;
    $('lessonAccountHint').textContent = isRegistered() ? t('progressSaved') : t('progressSignIn');
    const list = $('lessonList'); list.replaceChildren();
    state.lessons.forEach(lesson => {
      const card = element('button', 'lesson-card'); card.type = 'button';
      card.classList.toggle('selected', lesson.phrase_id === state.selected);
      card.setAttribute('aria-pressed', String(lesson.phrase_id === state.selected));
      card.append(element('span', 'card-index', String(lesson.position).padStart(2, '0')));
      const text = element('span', 'lesson-card-text');
      text.append(element('strong', '', lessonTitle(lesson)));
      text.append(element('small', '', t(lesson.progress === 'completed' ? 'lessonCompleted' : lesson.progress === 'in_progress' ? 'lessonInProgress' : lesson.available ? 'lessonReady' : 'lessonAwaiting')));
      card.append(text); card.onclick = () => selectLesson(lesson.phrase_id, true); list.append(card);
    });
    renderLessonDetail();
  }
  function renderLessonDetail() {
    const detail = $('lessonDetail'); detail.replaceChildren();
    const lesson = currentLesson();
    if (!lesson) { detail.append(element('p', 'muted', t('selectLesson'))); return; }
    detail.append(element('span', 'lesson-kicker', t('lessonNumber', {n: lesson.position})));
    detail.append(element('h2', '', lessonTitle(lesson)));
    if (!lesson.available) {
      detail.append(element('p', 'lesson-placeholder', t('lessonAwaitingDetail')));
      return;
    }
    if (lesson.has_video) {
      const video = element('video', 'lesson-video'); video.controls = true; video.playsInline = true; video.preload = 'metadata';
      video.src = `/api/lessons/${lesson.phrase_id}/video`; detail.append(video);
    }
    const instructions = locale === 'en' ? lesson.instructions_en || lesson.instructions_ru : lesson.instructions_ru || lesson.instructions_en;
    if (instructions) detail.append(element('p', 'lesson-instructions', instructions));
    detail.append(element('p', 'muted', t('referenceExamples', {n: lesson.reference_count})));
    const practice = element('button', 'button primary', t('practiceLesson')); practice.type = 'button';
    practice.disabled = !isRegistered() || lesson.reference_count < 1;
    practice.onclick = () => {
      state.practicePhrase = lesson.phrase_id;
      setPanel('studio'); renderPracticeNotice(); setFeedback(t('practiceNow', {phrase: lessonTitle(lesson)}));
    };
    detail.append(practice);
    if (!isRegistered()) detail.append(element('p', 'muted lesson-action-hint', t('signInForProgress')));
    else if (!lesson.reference_count) detail.append(element('p', 'muted lesson-action-hint', t('needReferenceToPractice')));
  }
  function renderPracticeNotice() {
    const lesson = state.lessons.find(row => row.phrase_id === state.practicePhrase);
    $('practiceNotice').hidden = !lesson;
    $('practiceNotice').textContent = lesson ? t('practiceNow', {phrase: lessonTitle(lesson)}) : '';
    $('backToLessonButton').hidden = !lesson;
  }
  function renderAdminEditor() {
    const chosen = $('adminPhrase').value || state.lessons[0]?.phrase_id;
    const lesson = state.lessons.find(item => item.phrase_id === chosen);
    $('instructionsRu').value = lesson?.instructions_ru || '';
    $('instructionsEn').value = lesson?.instructions_en || '';
    $('deleteLessonVideoButton').disabled = !lesson?.has_video;
  }
  function renderAdmin() {
    const selected = $('adminPhrase').value;
    $('adminPhrase').replaceChildren(...state.lessons.map(lesson => {
      const option = element('option', '', lessonTitle(lesson)); option.value = lesson.phrase_id; return option;
    }));
    if (state.lessons.some(item => item.phrase_id === selected)) $('adminPhrase').value = selected;
    renderAdminEditor();
    const users = $('adminUsers'); users.replaceChildren();
    state.users.forEach(user => {
      const row = element('div', 'admin-row');
      const text = element('span', 'admin-row-text'); text.append(element('strong', '', user.display_name), element('small', '', user.email));
      const action = element('button', 'button outline', t(user.role === 'admin' ? 'removeAdmin' : 'makeAdmin'));
      action.onclick = async () => {
        try { await api(`/api/admin/users/${encodeURIComponent(user.id)}/role`, {role: user.role === 'admin' ? 'student' : 'admin'}); state.me = await getJson('/api/me'); if (isAdmin()) await loadAdmin(); render(); setFeedback(t('roleUpdated')); }
        catch (error) { setFeedback(error.message, true); }
      };
      row.append(text, element('span', 'role-label', t(user.role === 'admin' ? 'roleAdmin' : 'roleStudent')), action); users.append(row);
    });
    const sampleList = $('adminSamples'); sampleList.replaceChildren();
    if (!state.samples.length) sampleList.append(element('p', 'muted', t('noReferences')));
    state.samples.forEach(sample => {
      const row = element('div', 'admin-row');
      const name = state.lessons.find(item => item.phrase_id === sample.phrase_id);
      row.append(element('span', 'admin-row-text', name ? lessonTitle(name) : sample.phrase_id));
      const action = element('button', 'button quiet', t('deleteReference'));
      action.onclick = async () => {
        if (!confirm(t('confirmDeleteReference'))) return;
        try { await send(`/api/admin/samples/${sample.sample_id}`, 'DELETE'); await Promise.all([refreshLessons(), loadAdmin(), refresh()]); setFeedback(t('referenceDeleted')); }
        catch (error) { setFeedback(error.message, true); }
      };
      row.append(action); sampleList.append(row);
    });
  }
  function render() { renderTheme(); renderAccount(); renderLessons(); if (isAdmin()) renderAdmin(); renderPracticeNotice(); }
  async function refreshLessons() {
    const data = await getJson('/api/lessons');
    state.lessons = data.lessons; state.completed = data.completed; state.total = data.total;
    if (!state.lessons.some(item => item.phrase_id === state.selected)) state.selected = state.lessons.find(item => item.available)?.phrase_id || state.lessons[0]?.phrase_id || null;
    renderLessons(); if (isAdmin()) renderAdmin();
  }
  async function loadAdmin() {
    if (!isAdmin()) return;
    const [users, samples] = await Promise.all([getJson('/api/admin/users'), getJson('/api/admin/samples')]);
    state.users = users.users; state.samples = samples.samples; renderAdmin();
  }
  async function selectLesson(id, markStarted) {
    state.selected = id; renderLessons();
    const lesson = currentLesson();
    if (markStarted && isRegistered() && lesson?.available) {
      try { await api(`/api/lessons/${id}/start`, {}); await refreshLessons(); }
      catch (error) { setFeedback(error.message, true); }
    }
  }
  async function init() {
    $('themeButton').onclick = () => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('signvision.theme', document.documentElement.dataset.theme); } catch (_) { /* private browsing */ }
      renderTheme();
    };
    $('registerButton').onclick = async () => {
      try { await api('/api/register', {display_name: $('displayName').value}); state.me = await getJson('/api/me'); await refreshLessons(); if (isAdmin()) await loadAdmin(); render(); setFeedback(t('profileCreated')); }
      catch (error) { setFeedback(error.message, true); }
    };
    $('adminPhrase').onchange = renderAdminEditor;
    $('saveLessonButton').onclick = async () => {
      try {
        await api(`/api/admin/lessons/${$('adminPhrase').value}`, {instructions_ru: $('instructionsRu').value, instructions_en: $('instructionsEn').value});
        await refreshLessons(); setFeedback(t('lessonSaved'));
      } catch (error) { setFeedback(error.message, true); }
    };
    $('lessonVideoFile').onchange = async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        if (file.size > 20 * 1024 * 1024) throw Error(t('lessonVideoTooLarge'));
        const type = file.type || (file.name.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');
        await send(`/api/admin/lessons/${$('adminPhrase').value}/video`, 'PUT', file, type);
        await refreshLessons(); setFeedback(t('lessonVideoSaved'));
      } catch (error) { setFeedback(error.message, true); }
      finally { event.target.value = ''; }
    };
    $('deleteLessonVideoButton').onclick = async () => {
      if (!confirm(t('confirmDeleteVideo'))) return;
      try { await send(`/api/admin/lessons/${$('adminPhrase').value}/video`, 'DELETE'); await refreshLessons(); setFeedback(t('lessonVideoDeleted')); }
      catch (error) { setFeedback(error.message, true); }
    };
    state.me = await getJson('/api/me');
    await refreshLessons();
    if (isAdmin()) await loadAdmin();
    render();
  }
  window.SignVisionLearning = {init, render, refreshLessons, loadAdmin, isAdmin, isRegistered,
    get practicePhrase() { return state.practicePhrase; },
    onPanel(name) { if (name === 'admin') loadAdmin().catch(error => setFeedback(error.message, true)); if (name === 'lessons') { state.practicePhrase = null; renderPracticeNotice(); refreshLessons().catch(error => setFeedback(error.message, true)); } },
    async onPracticeResult(data) { try { await refreshLessons(); } catch (error) { console.error('Progress refresh failed', error); } setFeedback(t(data.completed ? 'lessonCompletedFeedback' : 'lessonTryAgain')); },
  };
})();
