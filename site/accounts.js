class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const API_ERROR_EN = {
  'Войдите в аккаунт, чтобы продолжить.': 'Sign in to continue.',
  'Сначала создайте профиль.': 'Create a profile first.',
  'Доступно только администраторам.': 'Admins only.',
  'Войдите через ChatGPT перед регистрацией.': 'Sign in with ChatGPT before registering.',
  'Регистрация откроется после создания профиля владельца сайта.':
    'Registration opens after the site owner creates the first profile.',
  'Укажите имя профиля.': 'Enter a profile name.',
  'Неизвестная роль.': 'Unknown role.',
  'Пользователь не найден.': 'User not found.',
  'На сайте должен остаться хотя бы один администратор.': 'At least one admin must remain.',
  'Фраза не найдена.': 'Phrase not found.',
  'Материалы урока ещё не опубликованы.': 'Lesson materials are not published yet.',
  'Недостаточно кадров с руками.': 'Not enough frames with visible hands.',
  'Текст урока слишком длинный.': 'Lesson text is too long.',
  'Для урока нужен MP4 или WebM.': 'Use an MP4 or WebM lesson video.',
  'Видео урока должно быть не больше 20 МБ.': 'Lesson video must be 20 MB or smaller.',
  'Видео урока ещё не добавлено.': 'No lesson video has been added yet.',
  'Видео урока недоступно.': 'Lesson video is unavailable.',
  'Эталон не найден.': 'Reference not found.',
  'Укажите название фразы.': 'Enter a phrase name.',
  'Название фразы должно быть не длиннее 80 символов.':
    'Phrase names must be 80 characters or shorter.',
  'Такая фраза уже существует.': 'This phrase already exists.',
  'Такая фраза есть в удалённых. Восстановите её в словаре.':
    'This phrase was deleted. Restore it in the dictionary.',
  'Достигнут лимит новых фраз.': 'The custom phrase limit has been reached.',
  'Профили временно недоступны.': 'Profiles are temporarily unavailable.',
  'Уроки временно недоступны.': 'Lessons are temporarily unavailable.',
  'Укажите корректную почту.': 'Enter a valid email address.',
  'Пароль должен содержать от 12 до 128 символов.': 'Use a password between 12 and 128 characters.',
  'Недопустимый источник запроса.': 'Invalid request origin.',
  'Эта почта уже используется. Войдите через ChatGPT и добавьте пароль в профиле.':
    'This email is in use. Sign in with ChatGPT and add a password in your profile.',
  'Сначала владелец должен создать профиль через ChatGPT.':
    'The site owner must create a ChatGPT profile first.',
  'Неверная почта или пароль. После пяти ошибок вход временно блокируется.':
    'Invalid email or password. Sign-in is temporarily locked after five failed attempts.',
  'Сначала войдите через ChatGPT.': 'Sign in with ChatGPT first.',
  'Почта профиля не совпадает с почтой ChatGPT.':
    'Your profile email does not match your ChatGPT email.',
  'Вход по почте для этого профиля уже настроен.':
    'Email sign-in is already set up for this profile.',
  'Профиль с этой почтой уже существует. Войдите в него по почте.':
    'A profile with this email already exists. Sign in with email.',
};

function signedInIdentity(request) {
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email');
  if (!id || !email) {
    return null;
  }
  let fullName = '';
  if (
    request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8'
  ) {
    try {
      fullName = decodeURIComponent(request.headers.get('oai-authenticated-user-full-name') || '');
    } catch (_) {
      /* optional claim */
    }
  }
  return { id, email, fullName };
}

async function accountFor(request, db) {
  const sessionAccount = await emailSession(request, db);
  if (sessionAccount) {
    return {
      identity: { id: sessionAccount.id, email: sessionAccount.email },
      account: sessionAccount,
      authMethod: 'email',
    };
  }
  const identity = signedInIdentity(request);
  if (!identity) {
    return { identity: null, account: null };
  }
  const account = await db
    .prepare('SELECT id, email, display_name, role, created_at FROM accounts WHERE id = ?')
    .bind(identity.id)
    .first();
  return { identity, account, authMethod: 'chatgpt' };
}

async function requireAccount(request, db) {
  const { identity, account } = await accountFor(request, db);
  if (!identity) {
    throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
  }
  if (!account) {
    throw new ApiError('Сначала создайте профиль.', 403);
  }
  return account;
}

async function requireAdmin(request, db) {
  const account = await requireAccount(request, db);
  if (account.role !== 'admin') {
    throw new ApiError('Доступно только администраторам.', 403);
  }
  return account;
}

async function registerAccount(request, env, data) {
  const identity = signedInIdentity(request);
  if (!identity) {
    throw new ApiError('Войдите через ChatGPT перед регистрацией.', 401);
  }
  const db = env.DB;
  const existingEmail = await db
    .prepare('SELECT id FROM accounts WHERE lower(email) = ? LIMIT 1')
    .bind(identity.email.toLowerCase())
    .first();
  if (existingEmail && existingEmail.id !== identity.id) {
    throw new ApiError('Профиль с этой почтой уже существует. Войдите в него по почте.', 409);
  }
  const first = await db.prepare('SELECT id FROM accounts LIMIT 1').first();
  if (
    !first &&
    (!env.BOOTSTRAP_ADMIN_EMAIL ||
      identity.email.toLowerCase() !== env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase())
  ) {
    throw new ApiError('Регистрация откроется после создания профиля владельца сайта.', 403);
  }
  const name = String(data.display_name || identity.fullName || identity.email.split('@')[0])
    .trim()
    .slice(0, 80);
  if (!name) {
    throw new ApiError('Укажите имя профиля.');
  }
  await db
    .prepare(
      `INSERT INTO accounts (id, email, display_name, role, created_at)
    VALUES (?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM accounts) THEN 'student' ELSE 'admin' END, ?)
    ON CONFLICT(id) DO NOTHING`,
    )
    .bind(identity.id, identity.email, name, Date.now())
    .run();
  return (await accountFor(request, db)).account;
}

async function usersForAdmin(request, db) {
  await requireAdmin(request, db);
  const catalog = await phraseCatalog(db),
    ids = phraseIds(catalog);
  const rows = (
    await db
      .prepare(
        `SELECT a.id, a.email, a.display_name, a.role, a.created_at,
    p.phrase_id, p.status FROM accounts a
    LEFT JOIN lesson_progress p ON p.user_id = a.id
    ORDER BY a.created_at, a.id, p.phrase_id`,
      )
      .all()
  ).results;
  const users = new Map();
  for (const row of rows) {
    if (!users.has(row.id)) {
      users.set(row.id, {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        role: row.role,
        created_at: row.created_at,
        progress: { completed: 0, started: 0, total: catalog.length, lessons: {} },
      });
    }
    if (row.phrase_id && ids.has(row.phrase_id)) {
      const progress = users.get(row.id).progress;
      progress.lessons[row.phrase_id] = row.status;
      if (row.status === 'completed') {
        progress.completed++;
      }
      if (row.status === 'in_progress' || row.status === 'completed') {
        progress.started++;
      }
    }
  }
  return [...users.values()];
}

async function changeUserRole(request, db, targetId, role) {
  await requireAdmin(request, db);
  if (role !== 'admin' && role !== 'student') {
    throw new ApiError('Неизвестная роль.');
  }
  const target = await db
    .prepare('SELECT id, role FROM accounts WHERE id = ?')
    .bind(targetId)
    .first();
  if (!target) {
    throw new ApiError('Пользователь не найден.', 404);
  }
  if (role === 'student') {
    const result = await db
      .prepare(
        `UPDATE accounts SET role = 'student' WHERE id = ?
      AND (role != 'admin' OR (SELECT count(*) FROM accounts WHERE role = 'admin') > 1)`,
      )
      .bind(targetId)
      .run();
    if (!result.meta.changes && target.role === 'admin') {
      throw new ApiError('На сайте должен остаться хотя бы один администратор.', 409);
    }
  } else {
    await db.prepare("UPDATE accounts SET role = 'admin' WHERE id = ?").bind(targetId).run();
  }
  return db
    .prepare('SELECT id, email, display_name, role, created_at FROM accounts WHERE id = ?')
    .bind(targetId)
    .first();
}
