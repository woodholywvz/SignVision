import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../dist/server/index.js';
import {admin, student, environment, request} from './site-env.mjs';

const sequence = Array.from({length: 12}, () => { const frame = Array(284).fill(0); frame[0] = 1; return frame; });
const call = async (env, path, data, user = admin, method) => worker.fetch(request(path, data, user, method), env);

test('first registered profile is admin and can appoint another admin', async () => {
  const env = environment({seedAdmin: false});
  assert.equal((await call(env, '/api/register', {display_name: 'Second'}, student)).status, 403);
  const first = await call(env, '/api/register', {display_name: 'First'}, admin);
  assert.equal((await first.json()).account.role, 'admin');
  const second = await call(env, '/api/register', {display_name: 'Second'}, student);
  assert.equal((await second.json()).account.role, 'student');
  const anonymous = await call(env, '/api/me', undefined, null);
  assert.equal((await anonymous.json()).authenticated, false);
  const denied = await call(env, '/api/admin/users', undefined, student);
  assert.equal(denied.status, 403);
  const lastAdmin = await call(env, `/api/admin/users/${admin.id}/role`, {role: 'student'}, admin);
  assert.equal(lastAdmin.status, 409);
  const promoted = await call(env, `/api/admin/users/${student.id}/role`, {role: 'admin'}, admin);
  assert.equal((await promoted.json()).account.role, 'admin');
  const demoted = await call(env, `/api/admin/users/${admin.id}/role`, {role: 'student'}, student);
  assert.equal((await demoted.json()).account.role, 'student');
});

test('only admins change references and lesson material; student progress is private', async () => {
  const env = environment();
  await call(env, '/api/register', {display_name: 'Student'}, student);
  assert.equal((await call(env, '/api/samples', {phrase_id: 'privet', sequence}, student)).status, 403);
  assert.equal((await call(env, '/api/admin/lessons/privet', {instructions_ru: 'Повторите движение из видео.'}, student)).status, 403);
  const material = await call(env, '/api/admin/lessons/privet', {instructions_ru: 'Повторите движение из видео.'}, admin);
  assert.equal(material.status, 200);
  const saved = await call(env, '/api/samples', {phrase_id: 'privet', sequence}, admin);
  const sampleId = (await saved.json()).sample_id;
  const before = await call(env, '/api/lessons', undefined, student);
  assert.equal((await before.json()).lessons.find(item => item.phrase_id === 'privet').available, true);
  const started = await call(env, '/api/lessons/privet/start', {}, student);
  assert.equal((await started.json()).status, 'in_progress');
  const distant = sequence.map(frame => { const row = [...frame]; row.fill(2, 1, 64); return row; });
  const failedPractice = await call(env, '/api/lessons/privet/practice', {sequence: distant}, student);
  assert.equal((await failedPractice.json()).completed, false);
  const practice = await call(env, '/api/lessons/privet/practice', {sequence}, student);
  assert.equal((await practice.json()).completed, true);
  const progress = await call(env, '/api/lessons', undefined, student);
  assert.equal((await progress.json()).completed, 1);
  const users = await call(env, '/api/admin/users', undefined, admin);
  const studentRow = (await users.json()).users.find(user => user.id === student.id);
  assert.deepEqual(studentRow.progress, {completed: 1, started: 1, total: 5, lessons: {privet: 'completed'}});
  const other = await call(env, '/api/lessons', undefined, admin);
  assert.equal((await other.json()).completed, 0);
  assert.equal((await call(env, `/api/admin/samples/${sampleId}`, undefined, student, 'DELETE')).status, 403);
  assert.equal((await call(env, `/api/admin/samples/${sampleId}`, undefined, admin, 'DELETE')).status, 200);
  const config = await call(env, '/api/config');
  assert.equal((await config.json()).counts.privet, 0);
});

test('lesson video upload and removal are admin only', async () => {
  const env = environment();
  await call(env, '/api/register', {display_name: 'Student'}, student);
  const upload = user => worker.fetch(new Request('https://example.com/api/admin/lessons/privet/video', {
    method: 'PUT', headers: {'content-type': 'video/mp4', 'oai-authenticated-user-id': user.id, 'oai-authenticated-user-email': user.email},
    body: new Uint8Array([0, 1, 2, 3]),
  }), env);
  assert.equal((await upload(student)).status, 403);
  assert.equal((await upload(admin)).status, 200);
  const video = await call(env, '/api/lessons/privet/video', undefined, null);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal((await call(env, '/api/admin/lessons/privet/video', undefined, student, 'DELETE')).status, 403);
  assert.equal((await call(env, '/api/admin/lessons/privet/video', undefined, admin, 'DELETE')).status, 200);
  assert.equal((await call(env, '/api/lessons/privet/video', undefined, null)).status, 404);
});

test('admin-created phrases work in references, recognition, evaluation and lessons', async () => {
  const env = environment();
  const details = {text: 'Доброе утро', en: 'Good morning'};
  assert.equal((await call(env, '/api/admin/phrases', details, student)).status, 403);
  const created = await call(env, '/api/admin/phrases', details, admin);
  assert.equal(created.status, 201);
  const phrase = (await created.json()).phrase;
  assert.match(phrase.id, /^custom_[0-9a-f]+$/);
  assert.equal((await call(env, '/api/admin/phrases', {text: ' доброе   утро '}, admin)).status, 409);
  const config = await call(env, '/api/config');
  const catalog = await config.json();
  assert.equal(catalog.phrases.length, 6);
  assert.equal(catalog.counts[phrase.id], 0);
  const saved = await call(env, '/api/samples', {phrase_id: phrase.id, sequence}, admin);
  assert.equal((await saved.json()).counts[phrase.id], 1);
  const recognized = await call(env, '/api/recognize', {sequence}, student);
  assert.equal((await recognized.json()).text, 'Доброе утро');
  const englishRequest = request('/api/recognize', {sequence}, student);
  englishRequest.headers.set('accept-language', 'en');
  assert.equal((await (await worker.fetch(englishRequest, env)).json()).text, 'Good morning');
  const evaluated = await call(env, '/api/evaluate', {items: [{file: 'held-out.webm', expected: phrase.id, sequence}]}, admin);
  assert.equal((await evaluated.json()).correct, 1);
  assert.equal((await call(env, `/api/admin/lessons/${phrase.id}`, {instructions_ru: 'Повторите жест.'}, admin)).status, 200);
  await call(env, '/api/register', {display_name: 'Student'}, student);
  const lessons = await call(env, '/api/lessons', undefined, student);
  const listing = await lessons.json();
  assert.equal(listing.total, 6);
  assert.equal(listing.lessons.find(item => item.phrase_id === phrase.id).available, true);
  const practice = await call(env, `/api/lessons/${phrase.id}/practice`, {sequence}, student);
  assert.equal((await practice.json()).completed, true);
  const users = await call(env, '/api/admin/users', undefined, admin);
  assert.equal((await users.json()).users.find(user => user.id === student.id).progress.total, 6);
});
