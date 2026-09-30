import assert from 'node:assert/strict';
import test from 'node:test';
import { pbkdf2Sync } from 'node:crypto';
import worker from '../dist/server/index.js';
import { admin, student, environment, request } from './site-env.mjs';

const sequence = Array.from({ length: 12 }, () => {
  const frame = Array(284).fill(0);
  frame[0] = 1;
  return frame;
});
const call = async (env, path, data, user = admin, method) =>
  worker.fetch(request(path, data, user, method), env);

test('email login preserves legacy hashes under the production PBKDF2 iteration limit', async (t) => {
  const originalDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'deriveBits', (algorithm, ...args) => {
    if (algorithm.name === 'PBKDF2' && algorithm.iterations > 100000) {
      throw new DOMException(
        'Pbkdf2 iteration counts above 100000 are not supported',
        'NotSupportedError',
      );
    }
    return originalDeriveBits(algorithm, ...args);
  });
  const env = environment();
  const password = 'existing admin password 123';
  const salt = '0123456789abcdef0123456789abcdef';
  const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 210000, 32, 'sha256').toString('hex');
  env.sqlite
    .prepare(
      'INSERT INTO email_credentials (account_id, email_key, salt, password_hash, iterations, failed_attempts, locked_until, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, 1)',
    )
    .run(admin.id, admin.email, salt, hash, 210000);
  const login = await call(env, '/api/email/login', { email: admin.email, password }, null);
  assert.equal(login.status, 200);
  assert.equal((await login.json()).account.id, admin.id);
  assert.equal(
    env.sqlite
      .prepare('SELECT password_hash FROM email_credentials WHERE account_id = ?')
      .get(admin.id).password_hash,
    hash,
  );
  const wrong = await call(
    env,
    '/api/email/login',
    { email: admin.email, password: 'incorrect' },
    null,
  );
  assert.equal(wrong.status, 401);
  const registration = await call(
    env,
    '/api/email/register',
    { email: 'new@example.test', password, display_name: 'New' },
    null,
  );
  assert.equal(registration.status, 200);
  const missing = await call(
    env,
    '/api/email/login',
    { email: 'missing@example.test', password },
    null,
  );
  assert.equal(missing.status, 401);
});

test('first registered profile is admin and can appoint another admin', async () => {
  const env = environment({ seedAdmin: false });
  assert.equal((await call(env, '/api/register', { display_name: 'Second' }, student)).status, 403);
  const first = await call(env, '/api/register', { display_name: 'First' }, admin);
  assert.equal((await first.json()).account.role, 'admin');
  const second = await call(env, '/api/register', { display_name: 'Second' }, student);
  assert.equal((await second.json()).account.role, 'student');
  const anonymous = await call(env, '/api/me', undefined, null);
  assert.equal((await anonymous.json()).authenticated, false);
  const denied = await call(env, '/api/admin/users', undefined, student);
  assert.equal(denied.status, 403);
  const lastAdmin = await call(
    env,
    `/api/admin/users/${admin.id}/role`,
    { role: 'student' },
    admin,
  );
  assert.equal(lastAdmin.status, 409);
  const promoted = await call(env, `/api/admin/users/${student.id}/role`, { role: 'admin' }, admin);
  assert.equal((await promoted.json()).account.role, 'admin');
  const demoted = await call(
    env,
    `/api/admin/users/${admin.id}/role`,
    { role: 'student' },
    student,
  );
  assert.equal((await demoted.json()).account.role, 'student');
});

test('email registration, login, logout and ChatGPT account linking preserve accounts', async () => {
  const empty = environment({ seedAdmin: false });
  const emailData = {
    email: ' learner@example.test ',
    password: 'correct horse battery staple',
    display_name: 'Learner',
  };
  assert.equal((await call(empty, '/api/email/register', emailData, null)).status, 403);

  const env = environment();
  const registered = await call(env, '/api/email/register', emailData, null);
  assert.equal(registered.status, 200);
  const account = (await registered.json()).account;
  assert.equal(account.role, 'student');
  assert.equal(account.email, 'learner@example.test');
  const stored = env.sqlite
    .prepare('SELECT password_hash FROM email_credentials WHERE account_id = ?')
    .get(account.id);
  assert.notEqual(stored.password_hash, emailData.password);
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  const meRequest = request('/api/me', undefined, null);
  meRequest.headers.set('cookie', cookie);
  const me = await worker.fetch(meRequest, env);
  assert.equal((await me.json()).account.id, account.id);
  const lessonRequest = request('/api/lessons', undefined, null);
  lessonRequest.headers.set('cookie', cookie);
  assert.equal((await (await worker.fetch(lessonRequest, env)).json()).total, 5);
  assert.equal((await call(env, '/api/email/register', emailData, null)).status, 409);
  assert.equal(
    (
      await call(
        env,
        '/api/register',
        { display_name: 'Duplicate' },
        { id: 'chatgpt_other', email: 'LEARNER@example.test' },
      )
    ).status,
    409,
  );

  const logoutRequest = request('/api/email/logout', {}, null);
  logoutRequest.headers.set('cookie', cookie);
  assert.equal((await worker.fetch(logoutRequest, env)).status, 200);
  assert.equal((await (await worker.fetch(meRequest, env)).json()).authenticated, false);
  assert.equal(
    (
      await call(
        env,
        '/api/email/login',
        { email: emailData.email, password: 'wrong password' },
        null,
      )
    ).status,
    401,
  );
  const login = await call(
    env,
    '/api/email/login',
    { email: 'LEARNER@example.test', password: emailData.password },
    null,
  );
  assert.equal(login.status, 200);
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));

  const linked = await call(env, '/api/email/link', { password: 'long admin password 123' }, admin);
  assert.equal(linked.status, 200);
  const adminLogin = await call(
    env,
    '/api/email/login',
    { email: admin.email, password: 'long admin password 123' },
    null,
  );
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const adminRequest = request('/api/admin/users', undefined, null);
  adminRequest.headers.set('cookie', adminCookie);
  assert.equal((await worker.fetch(adminRequest, env)).status, 200);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM accounts').get().n, 2);
});

test('only admins change references and lesson material; student progress is private', async () => {
  const env = environment();
  await call(env, '/api/register', { display_name: 'Student' }, student);
  assert.equal(
    (await call(env, '/api/samples', { phrase_id: 'privet', sequence }, student)).status,
    403,
  );
  assert.equal(
    (
      await call(
        env,
        '/api/admin/lessons/privet',
        { instructions_ru: 'Повторите движение из видео.' },
        student,
      )
    ).status,
    403,
  );
  const material = await call(
    env,
    '/api/admin/lessons/privet',
    { instructions_ru: 'Повторите движение из видео.' },
    admin,
  );
  assert.equal(material.status, 200);
  const saved = await call(env, '/api/samples', { phrase_id: 'privet', sequence }, admin);
  const sampleId = (await saved.json()).sample_id;
  const before = await call(env, '/api/lessons', undefined, student);
  assert.equal(
    (await before.json()).lessons.find((item) => item.phrase_id === 'privet').available,
    true,
  );
  const started = await call(env, '/api/lessons/privet/start', {}, student);
  assert.equal((await started.json()).status, 'in_progress');
  const distant = sequence.map((frame) => {
    const row = [...frame];
    row.fill(2, 1, 64);
    return row;
  });
  const failedPractice = await call(
    env,
    '/api/lessons/privet/practice',
    { sequence: distant },
    student,
  );
  assert.equal((await failedPractice.json()).completed, false);
  const practice = await call(env, '/api/lessons/privet/practice', { sequence }, student);
  assert.equal((await practice.json()).completed, true);
  const progress = await call(env, '/api/lessons', undefined, student);
  assert.equal((await progress.json()).completed, 1);
  const users = await call(env, '/api/admin/users', undefined, admin);
  const studentRow = (await users.json()).users.find((user) => user.id === student.id);
  assert.deepEqual(studentRow.progress, {
    completed: 1,
    started: 1,
    total: 5,
    lessons: { privet: 'completed' },
  });
  const other = await call(env, '/api/lessons', undefined, admin);
  assert.equal((await other.json()).completed, 0);
  assert.equal(
    (await call(env, `/api/admin/samples/${sampleId}`, undefined, student, 'DELETE')).status,
    403,
  );
  assert.equal(
    (await call(env, `/api/admin/samples/${sampleId}`, undefined, admin, 'DELETE')).status,
    200,
  );
  const config = await call(env, '/api/config');
  assert.equal((await config.json()).counts.privet, 0);
});

test('admin reference list identifies new uploaders and keeps older references', async () => {
  const env = environment();
  const legacyId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const legacyDate = 1700000000000;
  await env.BUCKET.put(
    `samples/privet/${legacyId}.json`,
    JSON.stringify({ phrase_id: 'privet', sequence, created_at: legacyDate }),
  );
  await call(env, '/api/register', { display_name: 'Second admin' }, student);
  await call(env, `/api/admin/users/${student.id}/role`, { role: 'admin' }, admin);
  const uploaded = await call(env, '/api/samples', { phrase_id: 'privet', sequence }, student);
  const uploadedId = (await uploaded.json()).sample_id;
  assert.equal((await call(env, '/api/admin/samples', undefined, null)).status, 401);
  const listed = await call(env, '/api/admin/samples', undefined, admin);
  const items = (await listed.json()).samples;
  assert.equal(items.length, 2);
  const newItem = items.find((item) => item.sample_id === uploadedId);
  assert.equal(newItem.uploader_id, student.id);
  assert.equal(newItem.uploader_name, 'Second admin');
  assert.ok(newItem.created_at > legacyDate);
  const oldItem = items.find((item) => item.sample_id === legacyId);
  assert.equal(oldItem.created_at, legacyDate);
  assert.equal(oldItem.uploader_id, null);
  assert.equal(oldItem.uploader_name, null);
  assert.equal((await (await call(env, '/api/config')).json()).counts.privet, 2);
});

test('lesson video upload and removal are admin only', async () => {
  const env = environment();
  await call(env, '/api/register', { display_name: 'Student' }, student);
  const upload = (user) =>
    worker.fetch(
      new Request('https://example.com/api/admin/lessons/privet/video', {
        method: 'PUT',
        headers: {
          'content-type': 'video/mp4',
          'oai-authenticated-user-id': user.id,
          'oai-authenticated-user-email': user.email,
        },
        body: new Uint8Array([0, 1, 2, 3]),
      }),
      env,
    );
  assert.equal((await upload(student)).status, 403);
  assert.equal((await upload(admin)).status, 200);
  const video = await call(env, '/api/lessons/privet/video', undefined, null);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal(
    (await call(env, '/api/admin/lessons/privet/video', undefined, student, 'DELETE')).status,
    403,
  );
  assert.equal(
    (await call(env, '/api/admin/lessons/privet/video', undefined, admin, 'DELETE')).status,
    200,
  );
  assert.equal((await call(env, '/api/lessons/privet/video', undefined, null)).status, 404);
});

test('admin-created phrases work in references, recognition, evaluation and lessons', async () => {
  const env = environment();
  const details = { text: 'Доброе утро', en: 'Good morning' };
  assert.equal((await call(env, '/api/admin/phrases', details, student)).status, 403);
  const created = await call(env, '/api/admin/phrases', details, admin);
  assert.equal(created.status, 201);
  const phrase = (await created.json()).phrase;
  assert.match(phrase.id, /^custom_[0-9a-f]+$/);
  assert.equal(
    (await call(env, '/api/admin/phrases', { text: ' доброе   утро ' }, admin)).status,
    409,
  );
  const config = await call(env, '/api/config');
  const catalog = await config.json();
  assert.equal(catalog.phrases.length, 6);
  assert.equal(catalog.counts[phrase.id], 0);
  const saved = await call(env, '/api/samples', { phrase_id: phrase.id, sequence }, admin);
  assert.equal((await saved.json()).counts[phrase.id], 1);
  const recognized = await call(env, '/api/recognize', { sequence }, student);
  assert.equal((await recognized.json()).text, 'Доброе утро');
  const englishRequest = request('/api/recognize', { sequence }, student);
  englishRequest.headers.set('accept-language', 'en');
  assert.equal((await (await worker.fetch(englishRequest, env)).json()).text, 'Good morning');
  const evaluated = await call(
    env,
    '/api/evaluate',
    { items: [{ file: 'held-out.webm', expected: phrase.id, sequence }] },
    admin,
  );
  assert.equal((await evaluated.json()).correct, 1);
  assert.equal(
    (
      await call(
        env,
        `/api/admin/lessons/${phrase.id}`,
        { instructions_ru: 'Повторите жест.' },
        admin,
      )
    ).status,
    200,
  );
  await call(env, '/api/register', { display_name: 'Student' }, student);
  const lessons = await call(env, '/api/lessons', undefined, student);
  const listing = await lessons.json();
  assert.equal(listing.total, 6);
  assert.equal(listing.lessons.find((item) => item.phrase_id === phrase.id).available, true);
  const practice = await call(env, `/api/lessons/${phrase.id}/practice`, { sequence }, student);
  assert.equal((await practice.json()).completed, true);
  const users = await call(env, '/api/admin/users', undefined, admin);
  assert.equal((await users.json()).users.find((user) => user.id === student.id).progress.total, 6);
});
