/* Site accounts support ChatGPT identity and a separate email session. */
(function () {
  let theme;
  try {
    theme = localStorage.getItem('signvision.theme');
  } catch (_) {
    /* private browsing */
  }
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;

  const state = {
    me: null,
    lessons: [],
    completed: 0,
    total: 0,
    selected: null,
    users: [],
    usersLoading: false,
    usersError: '',
    samples: [],
    samplesError: '',
    archivedPhrases: [],
    archivedPhrasesError: '',
    practicePhrase: null,
  };
  let editorPhrase = null;
  let emailMode = 'login';
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (value !== undefined) {
      node.textContent = value;
    }
    return node;
  };
  const getJson = async (path) => {
    const response = await fetch(path);
    const data = await response.json();
    if (!response.ok) {
      throw Error(data.detail || t('requestFailed'));
    }
    return data;
  };
  const send = async (path, method, body, type) => {
    const response = await fetch(path, {
      method,
      headers: type ? { 'content-type': type } : undefined,
      body,
    });
    const data = await response.json();
    if (!response.ok) {
      throw Error(data.detail || t('requestFailed'));
    }
    return data;
  };
  const isAdmin = () => state.me?.account?.role === 'admin';
  const isRegistered = () => !!state.me?.registered;
  const currentLesson = () => state.lessons.find((lesson) => lesson.phrase_id === state.selected);
  const lessonTitle = (lesson) =>
    locale === 'en' ? lesson.title_en || lesson.title : lesson.title;

  function renderTheme() {
    $('themeButton').textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '◐';
    $('themeButton').setAttribute(
      'aria-label',
      t(document.documentElement.dataset.theme === 'dark' ? 'lightTheme' : 'darkTheme'),
    );
    $('themeButton').title = $('themeButton').getAttribute('aria-label');
  }
  function renderEmailMode() {
    $('emailLoginTab').setAttribute('aria-pressed', String(emailMode === 'login'));
    $('emailRegisterTab').setAttribute('aria-pressed', String(emailMode === 'register'));
    $('emailNameField').hidden = emailMode !== 'register';
    $('emailDisplayName').required = emailMode === 'register';
    $('emailPassword').autocomplete =
      emailMode === 'register' ? 'new-password' : 'current-password';
    $('emailSubmitButton').textContent = t(
      emailMode === 'register' ? 'emailRegister' : 'emailLogin',
    );
  }
  function renderAccount() {
    const me = state.me;
    $('signInLink').hidden = !!me?.authenticated;
    $('accountButton').hidden = !me?.authenticated;
    $('accountButton').textContent = me?.account?.display_name || t('createProfile');
    document.querySelector('[data-tab="admin"]').hidden = !isAdmin();
    $('signOutLink').hidden = !me?.authenticated || me.auth_method !== 'chatgpt';
    $('emailSignOutButton').hidden = !me?.authenticated || me.auth_method !== 'email';
    $('emailAuth').hidden = !!me?.authenticated;
    $('emailLink').hidden =
      !me?.registered || me.auth_method !== 'chatgpt' || me.has_email_password;
    $('emailLinkAddress').textContent = me?.account?.email || '';
    renderEmailMode();
    $('registrationForm').hidden = !me?.authenticated || !!me?.registered;
    if (me?.authenticated && !me?.registered && !$('displayName').value) {
      $('displayName').value = me.suggested_name || '';
    }
    const content = $('accountContent');
    content.replaceChildren();
    if (!me?.authenticated) {
      content.append(element('p', 'muted', t('accountSignInHint')));
      const link = element('a', 'button primary', t('signInChatGPT'));
      link.href = '/signin-with-chatgpt?return_to=%2F%3Ftab%3Daccount';
      link.onclick = () => window.SignVisionSounds?.markLogin();
      content.append(link);
    } else if (!me.registered) {
      content.append(element('p', 'muted', t('registerHint')));
    } else {
      content.append(element('strong', 'account-name', me.account.display_name));
      content.append(element('p', 'muted', me.account.email));
      content.append(
        element('p', 'role-label', t(me.account.role === 'admin' ? 'roleAdmin' : 'roleStudent')),
      );
    }
    const admin = isAdmin();
    $('datasetTip').dataset.i18n = admin ? 'tipDataset' : 'tipDatasetStudent';
    $('datasetTip').textContent = t($('datasetTip').dataset.i18n);
    $('goDatasetText').dataset.i18n = admin ? 'goDataset' : 'goDatasetStudent';
    $('goDatasetText').textContent = t($('goDatasetText').dataset.i18n);
    $('phrasesDescriptionText').dataset.i18n = admin
      ? 'phrasesDescription'
      : 'phrasesDescriptionStudent';
    $('phrasesDescriptionText').textContent = t($('phrasesDescriptionText').dataset.i18n);
    document.querySelector('.sample-panel').hidden = !admin;
    $('phraseCreate').hidden = !admin;
    $('datasetReadOnly').hidden = admin;
    $('archivedPhraseSection').hidden = !admin;
    $('useRecordingButton').hidden = !admin || !clip;
    renderHomeStatus();
    renderControls();
    if (!configLoading) {
      renderCatalog();
    }
    renderArchivedPhrases();
  }
  function renderArchivedPhrases() {
    const list = $('archivedPhraseList');
    list.replaceChildren();
    if (!isAdmin()) {
      return;
    }
    if (state.archivedPhrasesError) {
      list.append(element('p', 'admin-error', state.archivedPhrasesError));
      return;
    }
    if (!state.archivedPhrases.length) {
      list.append(element('p', 'muted', t('noArchivedPhrases')));
      return;
    }
    state.archivedPhrases.forEach((phrase) => {
      const row = element('div', 'admin-row');
      const name = locale === 'en' ? phrase.en : phrase.text;
      const action = element('button', 'button outline', t('restorePhrase'));
      action.type = 'button';
      action.setAttribute('aria-label', t('restorePhraseNamed', { phrase: name }));
      action.onclick = async () => {
        if (action.disabled) {
          return;
        }
        action.disabled = true;
        try {
          await api(`/api/admin/phrases/${encodeURIComponent(phrase.id)}/restore`, {});
          state.archivedPhrases = state.archivedPhrases.filter((item) => item.id !== phrase.id);
          renderArchivedPhrases();
          const updated = await Promise.allSettled([refresh(), refreshLessons(), loadAdmin()]);
          $('phraseRestoreStatus').textContent = t('phraseRestored', { phrase: name });
          const failed = updated.find((result) => result.status === 'rejected');
          if (failed) {
            $('phraseRestoreStatus').textContent += ' ' + failed.reason.message;
          }
        } catch (error) {
          action.disabled = false;
          $('phraseRestoreStatus').textContent = error.message;
        }
      };
      row.append(element('strong', 'admin-row-text', name), action);
      list.append(row);
    });
  }
  function renderHomeLessons() {
    const list = $('homeLessonList');
    list.replaceChildren();
    if (!state.lessons.length) {
      list.append(element('p', 'muted', t('homeLessonsLoading')));
      return;
    }
    state.lessons.slice(0, 5).forEach((lesson) => {
      const card = element('button', 'home-lesson');
      card.type = 'button';
      const number = element(
        'span',
        'home-lesson-number',
        String(lesson.position).padStart(2, '0'),
      );
      const title = element('strong', '', lessonTitle(lesson));
      const status = element(
        'small',
        '',
        t(
          lesson.progress === 'completed'
            ? 'lessonCompleted'
            : lesson.progress === 'in_progress'
              ? 'lessonInProgress'
              : lesson.available
                ? 'lessonReady'
                : 'lessonAwaiting',
        ),
      );
      const line = element('span', 'home-lesson-line');
      line.classList.toggle('completed', lesson.progress === 'completed');
      card.append(number, title, status, line);
      card.onclick = () => {
        setPanel('lessons');
        selectLesson(lesson.phrase_id, true);
      };
      list.append(card);
    });
  }
  function renderLessons() {
    $('lessonProgressText').textContent =
      `${state.completed} / ${state.total || state.lessons.length}`;
    $('lessonProgressBar').style.width =
      `${state.total ? Math.round((state.completed / state.total) * 100) : 0}%`;
    $('lessonAccountHint').textContent = isRegistered() ? t('progressSaved') : t('progressSignIn');
    const list = $('lessonList');
    list.replaceChildren();
    state.lessons.forEach((lesson) => {
      const card = element('button', 'lesson-card');
      card.type = 'button';
      card.classList.toggle('selected', lesson.phrase_id === state.selected);
      card.setAttribute('aria-pressed', String(lesson.phrase_id === state.selected));
      card.append(element('span', 'card-index', String(lesson.position).padStart(2, '0')));
      const text = element('span', 'lesson-card-text');
      text.append(element('strong', '', lessonTitle(lesson)));
      text.append(
        element(
          'small',
          '',
          t(
            lesson.progress === 'completed'
              ? 'lessonCompleted'
              : lesson.progress === 'in_progress'
                ? 'lessonInProgress'
                : lesson.available
                  ? 'lessonReady'
                  : 'lessonAwaiting',
          ),
        ),
      );
      card.append(text);
      card.onclick = () => selectLesson(lesson.phrase_id, true);
      list.append(card);
    });
    renderLessonDetail();
  }
  function renderLessonDetail() {
    const detail = $('lessonDetail');
    detail.replaceChildren();
    const lesson = currentLesson();
    if (!lesson) {
      detail.append(element('p', 'muted', t('selectLesson')));
      return;
    }
    detail.append(element('span', 'lesson-kicker', t('lessonNumber', { n: lesson.position })));
    detail.append(element('h2', '', lessonTitle(lesson)));
    if (!lesson.available) {
      detail.append(element('p', 'lesson-placeholder', t('lessonAwaitingDetail')));
      return;
    }
    if (lesson.has_video) {
      const video = element('video', 'lesson-video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = `/api/lessons/${lesson.phrase_id}/video`;
      detail.append(video);
    }
    const instructions =
      locale === 'en'
        ? lesson.instructions_en || lesson.instructions_ru
        : lesson.instructions_ru || lesson.instructions_en;
    if (instructions) {
      detail.append(element('p', 'lesson-instructions', instructions));
    }
    detail.append(element('p', 'muted', t('referenceExamples', { n: lesson.reference_count })));
    const practice = element('button', 'button primary', t('practiceLesson'));
    practice.type = 'button';
    practice.disabled = !isRegistered() || lesson.reference_count < 1;
    practice.onclick = () => {
      state.practicePhrase = lesson.phrase_id;
      setPanel('studio');
      renderPracticeNotice();
      setFeedback(t('practiceNow', { phrase: lessonTitle(lesson) }));
    };
    detail.append(practice);
    if (!isRegistered()) {
      detail.append(element('p', 'muted lesson-action-hint', t('signInForProgress')));
    } else if (!lesson.reference_count) {
      detail.append(element('p', 'muted lesson-action-hint', t('needReferenceToPractice')));
    }
  }
  function renderPracticeNotice() {
    const lesson = state.lessons.find((row) => row.phrase_id === state.practicePhrase);
    $('practiceNotice').hidden = !lesson;
    $('practiceNotice').textContent = lesson
      ? t('practiceNow', { phrase: lessonTitle(lesson) })
      : '';
    $('backToLessonButton').hidden = !lesson;
  }
  function renderAdminEditor(force = false) {
    const chosen = $('adminPhrase').value || state.lessons[0]?.phrase_id;
    const lesson = state.lessons.find((item) => item.phrase_id === chosen);
    if (force || editorPhrase !== chosen) {
      $('instructionsRu').value = lesson?.instructions_ru || '';
      $('instructionsEn').value = lesson?.instructions_en || '';
      editorPhrase = chosen;
    }
    $('deleteLessonVideoButton').disabled = !lesson?.has_video;
  }
  function renderAdminSamples() {
    const filter = $('samplePhraseFilter');
    const selected = filter.value;
    const choices = [element('option', '', t('allReferencePhrases'))];
    choices[0].value = '';
    state.lessons.forEach((lesson) => {
      if (!state.samples.some((sample) => sample.phrase_id === lesson.phrase_id)) {
        return;
      }
      const option = element('option', '', lessonTitle(lesson));
      option.value = lesson.phrase_id;
      choices.push(option);
    });
    filter.replaceChildren(...choices);
    if (choices.some((choice) => choice.value === selected)) {
      filter.value = selected;
    }
    const visible = state.samples
      .filter((sample) => !filter.value || sample.phrase_id === filter.value)
      .sort(
        (a, b) =>
          a.phrase_id.localeCompare(b.phrase_id) ||
          (b.created_at || 0) - (a.created_at || 0) ||
          a.sample_id.localeCompare(b.sample_id),
      );
    $('sampleListCount').textContent = t('referenceListCount', {
      shown: visible.length,
      total: state.samples.length,
    });
    const sampleList = $('adminSamples');
    sampleList.replaceChildren();
    if (state.samplesError) {
      sampleList.append(element('p', 'admin-error', state.samplesError));
      return;
    }
    if (!state.samples.length) {
      sampleList.append(element('p', 'muted', t('noReferences')));
      return;
    }
    if (!visible.length) {
      sampleList.append(element('p', 'muted', t('noReferencesForPhrase')));
      return;
    }
    visible.forEach((sample) => {
      const row = element('div', 'admin-row admin-sample-row');
      const lesson = state.lessons.find((item) => item.phrase_id === sample.phrase_id);
      const name = lesson ? lessonTitle(lesson) : sample.phrase_id;
      const date =
        Number.isFinite(sample.created_at) && Number.isFinite(new Date(sample.created_at).getTime())
          ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
              sample.created_at,
            )
          : t('referenceDateUnknown');
      const uploader = sample.uploader_name || t('referenceUploaderUnknown');
      const label = element('div', 'admin-row-text');
      label.append(
        element('strong', '', name),
        element('small', '', t('referenceUploadedAt', { date })),
        element('small', '', t('referenceUploadedBy', { name: uploader })),
        element('small', 'admin-sample-id', t('referenceId', { id: sample.sample_id.slice(0, 8) })),
      );
      const action = element('button', 'button quiet', t('deleteReference'));
      action.type = 'button';
      action.onclick = async () => {
        if (
          !confirm(
            t('confirmDeleteReferenceDetails', {
              phrase: name,
              date,
              uploader,
              id: sample.sample_id.slice(0, 8),
            }),
          )
        ) {
          return;
        }
        action.disabled = true;
        try {
          await send(`/api/admin/samples/${sample.sample_id}`, 'DELETE');
          await Promise.all([refreshLessons(), loadAdmin(), refresh()]);
          setFeedback(t('referenceDeleted'));
        } catch (error) {
          action.disabled = false;
          setFeedback(error.message, true);
        }
      };
      row.append(label, action);
      sampleList.append(row);
    });
  }
  function renderAdmin() {
    const selected = $('adminPhrase').value;
    $('adminPhrase').replaceChildren(
      ...state.lessons.map((lesson) => {
        const option = element('option', '', lessonTitle(lesson));
        option.value = lesson.phrase_id;
        return option;
      }),
    );
    if (state.lessons.some((item) => item.phrase_id === selected)) {
      $('adminPhrase').value = selected;
    }
    renderAdminEditor();
    const users = $('adminUsers');
    const expanded = new Set(
      [...users.querySelectorAll('.admin-user:has(details[open])')].map(
        (row) => row.dataset.userId,
      ),
    );
    users.replaceChildren();
    $('adminUserSummary').textContent = t('registeredUsers', { n: state.users.length });
    if (state.usersLoading) {
      users.append(element('p', 'muted', t('loadingUsers')));
    }
    if (state.usersError) {
      users.append(element('p', 'admin-error', state.usersError));
      const retry = element('button', 'button outline', t('retryUsers'));
      retry.type = 'button';
      retry.onclick = () => loadAdmin();
      users.append(retry);
    }
    if (!state.usersLoading && !state.usersError && !state.users.length) {
      users.append(element('p', 'muted', t('noUsers')));
    }
    state.users.forEach((user) => {
      const row = element('article', 'admin-user');
      row.dataset.userId = user.id;
      const heading = element('div', 'admin-user-heading');
      const text = element('div', 'admin-row-text');
      text.append(element('strong', '', user.display_name), element('small', '', user.email));
      heading.append(
        text,
        element('span', 'role-label', t(user.role === 'admin' ? 'roleAdmin' : 'roleStudent')),
      );
      const progress = user.progress || {
        completed: 0,
        started: 0,
        total: state.lessons.length,
        lessons: {},
      };
      const label = element(
        'p',
        'admin-progress-label',
        t('userProgress', { completed: progress.completed, total: progress.total }),
      );
      const bar = element('div', 'progress-track');
      const fill = element('span');
      fill.style.width = `${progress.total ? Math.round((progress.completed / progress.total) * 100) : 0}%`;
      bar.append(fill);
      const details = element('details', 'admin-user-details');
      details.open = expanded.has(user.id);
      details.append(element('summary', '', t('lessonProgressDetails')));
      const list = element('ul');
      state.lessons.forEach((lesson) => {
        const status = progress.lessons?.[lesson.phrase_id] || 'not_started';
        const item = element('li');
        item.append(
          element('span', '', lessonTitle(lesson)),
          element(
            'small',
            '',
            t(
              status === 'completed'
                ? 'lessonCompleted'
                : status === 'in_progress'
                  ? 'lessonInProgress'
                  : 'lessonNotStarted',
            ),
          ),
        );
        list.append(item);
      });
      details.append(list);
      const action = element(
        'button',
        'button outline',
        t(user.role === 'admin' ? 'removeAdmin' : 'makeAdmin'),
      );
      action.type = 'button';
      if (
        user.role === 'admin' &&
        state.users.filter((item) => item.role === 'admin').length === 1
      ) {
        action.disabled = true;
        action.title = t('lastAdminHint');
      }
      action.onclick = async () => {
        action.disabled = true;
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.id)}/role`, {
            role: user.role === 'admin' ? 'student' : 'admin',
          });
          state.me = await getJson('/api/me');
          if (isAdmin()) {
            await loadAdmin();
          } else {
            setPanel('account');
          }
          render();
          setFeedback(t('roleUpdated'));
        } catch (error) {
          setFeedback(error.message, true);
        } finally {
          action.disabled = false;
        }
      };
      const footer = element('div', 'admin-user-footer');
      footer.append(action);
      row.append(heading, label, bar, details, footer);
      users.append(row);
    });
    renderAdminSamples();
  }
  function render() {
    renderTheme();
    window.SignVisionSounds?.render();
    renderAccount();
    renderLessons();
    renderHomeLessons();
    if (isAdmin()) {
      renderAdmin();
    }
    renderPracticeNotice();
    renderArchivedPhrases();
    renderResult();
  }
  async function refreshLessons() {
    const data = await getJson('/api/lessons');
    state.lessons = data.lessons;
    state.completed = data.completed;
    state.total = data.total;
    if (!state.lessons.some((item) => item.phrase_id === state.selected)) {
      state.selected =
        state.lessons.find((item) => item.available)?.phrase_id ||
        state.lessons[0]?.phrase_id ||
        null;
    }
    if (
      state.practicePhrase &&
      !state.lessons.some((item) => item.phrase_id === state.practicePhrase)
    ) {
      state.practicePhrase = null;
    }
    renderLessons();
    renderHomeLessons();
    if (isAdmin()) {
      renderAdmin();
    }
  }
  async function loadAdmin() {
    if (!isAdmin()) {
      return;
    }
    state.usersLoading = true;
    state.usersError = '';
    renderAdmin();
    const [users, samples, archived] = await Promise.allSettled([
      getJson('/api/admin/users'),
      getJson('/api/admin/samples'),
      getJson('/api/admin/phrases/archived'),
    ]);
    state.usersLoading = false;
    if (users.status === 'fulfilled') {
      state.users = users.value.users;
      state.usersError = '';
    } else {
      state.users = [];
      state.usersError = users.reason.message;
    }
    if (samples.status === 'fulfilled') {
      state.samples = samples.value.samples;
      state.samplesError = '';
    } else {
      state.samples = [];
      state.samplesError = samples.reason.message;
    }
    state.archivedPhrases = archived.status === 'fulfilled' ? archived.value.phrases : [];
    state.archivedPhrasesError = archived.status === 'fulfilled' ? '' : archived.reason.message;
    renderArchivedPhrases();
    renderAdmin();
  }
  async function selectLesson(id, markStarted) {
    state.selected = id;
    renderLessons();
    const lesson = currentLesson();
    if (markStarted && isRegistered() && lesson?.available) {
      try {
        await api(`/api/lessons/${id}/start`, {});
        await refreshLessons();
      } catch (error) {
        setFeedback(error.message, true);
      }
    }
  }
  async function init() {
    $('themeButton').onclick = () => {
      document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('signvision.theme', document.documentElement.dataset.theme);
      } catch (_) {
        /* private browsing */
      }
      renderTheme();
    };
    $('registerButton').onclick = async () => {
      try {
        await api('/api/register', { display_name: $('displayName').value });
        state.me = await getJson('/api/me');
        render();
        setFeedback(t('profileCreated'));
        window.SignVisionSounds?.play('register');
        refreshAccountContent();
      } catch (error) {
        setFeedback(error.message, true);
      }
    };
    $('emailLoginTab').onclick = () => {
      emailMode = 'login';
      renderEmailMode();
    };
    $('emailRegisterTab').onclick = () => {
      emailMode = 'register';
      renderEmailMode();
    };
    $('emailAuthForm').onsubmit = async (event) => {
      event.preventDefault();
      const button = $('emailSubmitButton');
      button.disabled = true;
      try {
        await api(emailMode === 'register' ? '/api/email/register' : '/api/email/login', {
          email: $('emailAddress').value,
          password: $('emailPassword').value,
          display_name: $('emailDisplayName').value,
        });
        state.me = await getJson('/api/me');
        render();
        setFeedback(t(emailMode === 'register' ? 'emailRegistered' : 'emailLoggedIn'));
        window.SignVisionSounds?.play(emailMode === 'register' ? 'register' : 'login');
        refreshAccountContent();
      } catch (error) {
        setFeedback(error.message, true);
      } finally {
        $('emailPassword').value = '';
        button.disabled = false;
      }
    };
    $('emailLinkForm').onsubmit = async (event) => {
      event.preventDefault();
      const button = $('emailLinkForm button');
      button.disabled = true;
      try {
        await api('/api/email/link', { password: $('emailLinkPassword').value });
        state.me = await getJson('/api/me');
        render();
        setFeedback(t('emailLinked'));
      } catch (error) {
        setFeedback(error.message, true);
      } finally {
        $('emailLinkPassword').value = '';
        button.disabled = false;
      }
    };
    $('emailSignOutButton').onclick = async () => {
      try {
        await api('/api/email/logout', {});
        state.me = await getJson('/api/me');
        await refreshLessons();
        render();
        setPanel('account');
      } catch (error) {
        setFeedback(error.message, true);
      }
    };
    $('adminPhrase').onchange = () => renderAdminEditor(true);
    $('samplePhraseFilter').onchange = renderAdminSamples;
    $('saveLessonButton').onclick = async () => {
      try {
        await api(`/api/admin/lessons/${$('adminPhrase').value}`, {
          instructions_ru: $('instructionsRu').value,
          instructions_en: $('instructionsEn').value,
        });
        editorPhrase = null;
        await refreshLessons();
        setFeedback(t('lessonSaved'));
      } catch (error) {
        setFeedback(error.message, true);
      }
    };
    $('lessonVideoFile').onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) {
        return;
      }
      try {
        if (file.size > 20 * 1024 * 1024) {
          throw Error(t('lessonVideoTooLarge'));
        }
        const type =
          file.type || (file.name.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');
        await send(`/api/admin/lessons/${$('adminPhrase').value}/video`, 'PUT', file, type);
        await refreshLessons();
        setFeedback(t('lessonVideoSaved'));
      } catch (error) {
        setFeedback(error.message, true);
      } finally {
        event.target.value = '';
      }
    };
    $('deleteLessonVideoButton').onclick = async () => {
      if (!confirm(t('confirmDeleteVideo'))) {
        return;
      }
      try {
        await send(`/api/admin/lessons/${$('adminPhrase').value}/video`, 'DELETE');
        await refreshLessons();
        setFeedback(t('lessonVideoDeleted'));
      } catch (error) {
        setFeedback(error.message, true);
      }
    };
    render();
    const requestedPanel = new URLSearchParams(location.search).get('tab');
    if (requestedPanel) {
      setPanel(requestedPanel, true);
    }
    state.me = await getJson('/api/me');
    render();
    window.SignVisionSounds?.completeLogin(state.me.authenticated);
    if (requestedPanel === 'admin' && isAdmin()) {
      setPanel('admin', true);
    }
    refreshAccountContent();
  }
  function refreshAccountContent() {
    refreshLessons().catch((error) => setFeedback(error.message, true));
    if (isAdmin()) {
      loadAdmin().catch((error) => setFeedback(error.message, true));
    }
  }
  window.SignVisionLearning = {
    init,
    render,
    refreshLessons,
    loadAdmin,
    isAdmin,
    isRegistered,
    get practicePhrase() {
      return state.practicePhrase;
    },
    onPanel(name) {
      if (name === 'admin' || (name === 'dataset' && isAdmin())) {
        loadAdmin().catch((error) => setFeedback(error.message, true));
      }
      if (name === 'lessons') {
        state.practicePhrase = null;
        renderPracticeNotice();
        refreshLessons().catch((error) => setFeedback(error.message, true));
      }
    },
    async onPracticeResult(data) {
      if (data.completed) {
        window.SignVisionSounds?.play('lesson');
      }
      try {
        await refreshLessons();
      } catch (error) {
        console.error('Progress refresh failed', error);
      }
      setFeedback(t(data.completed ? 'lessonCompletedFeedback' : 'lessonTryAgain'));
    },
  };
})();
