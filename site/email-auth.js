import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 as hashSha256 } from '@noble/hashes/sha2.js';

const EMAIL_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 210000;
const encoder = new TextEncoder();

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(value) {
  return new Uint8Array(value.match(/.{2}/g).map((part) => parseInt(part, 16)));
}

function randomHex(size) {
  return hex(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function passwordHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  // Workers limits native PBKDF2 to 100,000 iterations. Use the same PBKDF2
  // algorithm in JS above that limit, preserving existing credential hashes.
  if (iterations > 100000) {
    return hex(
      await pbkdf2Async(hashSha256, encoder.encode(password), unhex(salt), {
        c: iterations,
        dkLen: 32,
      }),
    );
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

function sameHash(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function emailKey(value) {
  const email = String(value || '')
    .trim()
    .toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError('Укажите корректную почту.');
  }
  return email;
}

function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new ApiError('Пароль должен содержать от 12 до 128 символов.');
  }
  return value;
}

function checkAuthOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError('Недопустимый источник запроса.', 403);
  }
}

function sessionToken(request) {
  return (
    request.headers.get('cookie')?.match(/(?:^|;\s*)sv_session=([0-9a-f]{64})(?:;|$)/)?.[1] || null
  );
}

async function emailSession(request, db) {
  const token = sessionToken(request);
  if (!token) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT a.id, a.email, a.display_name, a.role, a.created_at
    FROM email_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256(token), Date.now())
    .first();
  return row || null;
}

async function issueSession(db, accountId) {
  const token = randomHex(32);
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO email_sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(await sha256(token), accountId, now + EMAIL_SESSION_MS, now)
    .run();
  return `sv_session=${token}; Path=/; Max-Age=${EMAIL_SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return 'sv_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
}

async function registerEmail(request, env, data) {
  checkAuthOrigin(request);
  const email = emailKey(data.email);
  const password = passwordValue(data.password);
  const name = String(data.display_name || '')
    .trim()
    .slice(0, 80);
  if (!name) {
    throw new ApiError('Укажите имя профиля.');
  }
  if (
    await env.DB.prepare('SELECT id FROM accounts WHERE lower(email) = ? LIMIT 1')
      .bind(email)
      .first()
  ) {
    throw new ApiError(
      'Эта почта уже используется. Войдите через ChatGPT и добавьте пароль в профиле.',
      409,
    );
  }
  if (!(await env.DB.prepare('SELECT id FROM accounts LIMIT 1').first())) {
    throw new ApiError('Сначала владелец должен создать профиль через ChatGPT.', 403);
  }
  const accountId = `email_${crypto.randomUUID()}`;
  const salt = randomHex(16);
  const hash = await passwordHash(password, salt);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO accounts (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(accountId, email, name, 'student', now),
    env.DB.prepare(
      `INSERT INTO email_credentials
      (account_id, email_key, salt, password_hash, iterations, failed_attempts, locked_until, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    ).bind(accountId, email, salt, hash, PASSWORD_ITERATIONS, now),
  ]);
  const account = await env.DB.prepare(
    'SELECT id, email, display_name, role, created_at FROM accounts WHERE id = ?',
  )
    .bind(accountId)
    .first();
  return { account, cookie: await issueSession(env.DB, accountId) };
}

async function loginEmail(request, env, data) {
  checkAuthOrigin(request);
  const email = emailKey(data.email);
  const password = String(data.password || '');
  const credential = await env.DB.prepare(
    `SELECT c.account_id, c.salt, c.password_hash, c.iterations,
    c.failed_attempts, c.locked_until FROM email_credentials c WHERE c.email_key = ?`,
  )
    .bind(email)
    .first();
  // The same derivation for missing accounts avoids a fast account-existence probe.
  const hash = await passwordHash(
    password,
    credential?.salt || '00000000000000000000000000000000',
    credential?.iterations || PASSWORD_ITERATIONS,
  );
  if (
    !credential ||
    credential.locked_until > Date.now() ||
    !sameHash(hash, credential.password_hash)
  ) {
    if (credential && credential.locked_until <= Date.now()) {
      const failures = credential.failed_attempts + 1;
      await env.DB.prepare(
        'UPDATE email_credentials SET failed_attempts = ?, locked_until = ? WHERE account_id = ?',
      )
        .bind(failures, failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0, credential.account_id)
        .run();
    }
    throw new ApiError(
      'Неверная почта или пароль. После пяти ошибок вход временно блокируется.',
      401,
    );
  }
  await env.DB.prepare(
    'UPDATE email_credentials SET failed_attempts = 0, locked_until = 0 WHERE account_id = ?',
  )
    .bind(credential.account_id)
    .run();
  const account = await env.DB.prepare(
    'SELECT id, email, display_name, role, created_at FROM accounts WHERE id = ?',
  )
    .bind(credential.account_id)
    .first();
  return { account, cookie: await issueSession(env.DB, credential.account_id) };
}

async function linkEmailPassword(request, env, data) {
  checkAuthOrigin(request);
  const identity = signedInIdentity(request);
  if (!identity) {
    throw new ApiError('Сначала войдите через ChatGPT.', 401);
  }
  const account = await env.DB.prepare('SELECT id, email FROM accounts WHERE id = ?')
    .bind(identity.id)
    .first();
  if (!account || account.email.toLowerCase() !== identity.email.toLowerCase()) {
    throw new ApiError('Почта профиля не совпадает с почтой ChatGPT.', 403);
  }
  const password = passwordValue(data.password);
  const existing = await env.DB.prepare(
    'SELECT account_id FROM email_credentials WHERE email_key = ?',
  )
    .bind(emailKey(account.email))
    .first();
  if (existing) {
    throw new ApiError('Вход по почте для этого профиля уже настроен.', 409);
  }
  const salt = randomHex(16);
  const hash = await passwordHash(password, salt);
  await env.DB.prepare(
    `INSERT INTO email_credentials
    (account_id, email_key, salt, password_hash, iterations, failed_attempts, locked_until, created_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
  )
    .bind(account.id, emailKey(account.email), salt, hash, PASSWORD_ITERATIONS, Date.now())
    .run();
  return { linked: true };
}

async function logoutEmail(request, db) {
  checkAuthOrigin(request);
  const token = sessionToken(request);
  if (token) {
    await db
      .prepare('DELETE FROM email_sessions WHERE token_hash = ?')
      .bind(await sha256(token))
      .run();
  }
  return { cookie: clearSessionCookie() };
}
