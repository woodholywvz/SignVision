async function materialFor(db, phraseId) {
  return db
    .prepare(
      'SELECT phrase_id, instructions_ru, instructions_en, video_key, updated_at FROM lesson_materials WHERE phrase_id = ?',
    )
    .bind(phraseId)
    .first();
}

function materialAvailable(row) {
  return !!(row && (row.instructions_ru || row.instructions_en || row.video_key));
}

async function listLessons(request, env) {
  const catalog = await phraseCatalog(env.DB);
  const ids = phraseIds(catalog);
  const { account } = await accountFor(request, env.DB);
  const materials = (
    await env.DB.prepare(
      'SELECT phrase_id, instructions_ru, instructions_en, video_key, updated_at FROM lesson_materials',
    ).all()
  ).results;
  const progress = account
    ? (
        await env.DB.prepare(
          'SELECT phrase_id, status, started_at, completed_at FROM lesson_progress WHERE user_id = ?',
        )
          .bind(account.id)
          .all()
      ).results
    : [];
  const examples = counts(await samples(env.BUCKET, catalog), catalog);
  const byMaterial = new Map(materials.map((item) => [item.phrase_id, item]));
  const byProgress = new Map(progress.map((item) => [item.phrase_id, item]));
  const lessons = catalog.map((phrase, index) => {
    const material = byMaterial.get(phrase.id),
      state = byProgress.get(phrase.id);
    return {
      phrase_id: phrase.id,
      title: phrase.text,
      title_en: phrase.en,
      position: index + 1,
      instructions_ru: material?.instructions_ru || '',
      instructions_en: material?.instructions_en || '',
      has_video: !!material?.video_key,
      available: materialAvailable(material),
      reference_count: examples[phrase.id],
      progress: state?.status || 'not_started',
      completed_at: state?.completed_at || null,
    };
  });
  return {
    lessons,
    completed: progress.filter((row) => row.status === 'completed' && ids.has(row.phrase_id))
      .length,
    total: catalog.length,
  };
}

async function startLesson(request, env, phraseId) {
  await phraseOrThrow(env.DB, phraseId);
  const account = await requireAccount(request, env.DB);
  if (!materialAvailable(await materialFor(env.DB, phraseId))) {
    throw new ApiError('Материалы урока ещё не опубликованы.', 409);
  }
  await env.DB.prepare(
    `INSERT INTO lesson_progress (user_id, phrase_id, status, started_at, completed_at)
    VALUES (?, ?, 'in_progress', ?, NULL)
    ON CONFLICT(user_id, phrase_id) DO NOTHING`,
  )
    .bind(account.id, phraseId, Date.now())
    .run();
  return {
    phrase_id: phraseId,
    status: (
      await env.DB.prepare('SELECT status FROM lesson_progress WHERE user_id = ? AND phrase_id = ?')
        .bind(account.id, phraseId)
        .first()
    ).status,
  };
}

async function practiceLesson(request, env, phraseId, data) {
  await phraseOrThrow(env.DB, phraseId);
  const account = await requireAccount(request, env.DB);
  if (!materialAvailable(await materialFor(env.DB, phraseId))) {
    throw new ApiError('Материалы урока ещё не опубликованы.', 409);
  }
  const sequence = trimSequence(data.sequence);
  if (!validSequence(data.sequence, 0)) {
    throw new ApiError('Недостаточно кадров или неверный формат записи.', 422);
  }
  const catalog = await phraseCatalog(env.DB);
  const prediction = validSequence(sequence)
    ? predict(
        sequence,
        await samples(env.BUCKET, catalog),
        language(request),
        false,
        { ...data.quality, duration_s: data.duration_s },
        catalog,
      )
    : missingHandsPrediction(sequence.length);
  const completed = prediction.phrase_id === phraseId;
  const now = Date.now();
  if (completed) {
    await env.DB.prepare(
      `INSERT INTO lesson_progress (user_id, phrase_id, status, started_at, completed_at)
      VALUES (?, ?, 'completed', ?, ?)
      ON CONFLICT(user_id, phrase_id) DO UPDATE SET status = 'completed', completed_at = excluded.completed_at`,
    )
      .bind(account.id, phraseId, now, now)
      .run();
  } else {
    await startLesson(request, env, phraseId);
  }
  return { completed, expected: phraseId, prediction };
}

async function saveLessonMaterial(request, env, phraseId, data) {
  await phraseOrThrow(env.DB, phraseId);
  await requireAdmin(request, env.DB);
  const ru = String(data.instructions_ru || '').trim(),
    en = String(data.instructions_en || '').trim();
  if (ru.length > 4000 || en.length > 4000) {
    throw new ApiError('Текст урока слишком длинный.');
  }
  await env.DB.prepare(
    `INSERT INTO lesson_materials (phrase_id, instructions_ru, instructions_en, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phrase_id) DO UPDATE SET instructions_ru = excluded.instructions_ru,
    instructions_en = excluded.instructions_en, updated_at = excluded.updated_at`,
  )
    .bind(phraseId, ru, en, Date.now())
    .run();
  return { phrase_id: phraseId, instructions_ru: ru, instructions_en: en };
}

async function uploadLessonVideo(request, env, phraseId) {
  await phraseOrThrow(env.DB, phraseId);
  await requireAdmin(request, env.DB);
  const type = (request.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['video/mp4', 'video/webm'].includes(type)) {
    throw new ApiError('Для урока нужен MP4 или WebM.');
  }
  if (Number(request.headers.get('content-length') || 0) > 20 * 1024 * 1024) {
    throw new ApiError('Видео урока должно быть не больше 20 МБ.', 413);
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) {
    throw new ApiError('Видео урока должно быть не больше 20 МБ.', 413);
  }
  const old = await materialFor(env.DB, phraseId);
  const key = `lesson-videos/${phraseId}/${crypto.randomUUID()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await env.DB.prepare(
      `INSERT INTO lesson_materials (phrase_id, instructions_ru, instructions_en, video_key, updated_at)
      VALUES (?, '', '', ?, ?)
      ON CONFLICT(phrase_id) DO UPDATE SET video_key = excluded.video_key, updated_at = excluded.updated_at`,
    )
      .bind(phraseId, key, Date.now())
      .run();
  } catch (caught) {
    await env.BUCKET.delete(key);
    throw caught;
  }
  if (old?.video_key) {
    await env.BUCKET.delete(old.video_key);
  }
  return { phrase_id: phraseId, has_video: true };
}

async function deleteLessonVideo(request, env, phraseId) {
  await phraseOrThrow(env.DB, phraseId);
  await requireAdmin(request, env.DB);
  const row = await materialFor(env.DB, phraseId);
  if (!row?.video_key) {
    return { phrase_id: phraseId, has_video: false };
  }
  await env.DB.prepare(
    'UPDATE lesson_materials SET video_key = NULL, updated_at = ? WHERE phrase_id = ?',
  )
    .bind(Date.now(), phraseId)
    .run();
  await env.BUCKET.delete(row.video_key);
  return { phrase_id: phraseId, has_video: false };
}

async function serveLessonVideo(env, phraseId) {
  await phraseOrThrow(env.DB, phraseId);
  const row = await materialFor(env.DB, phraseId);
  if (!row?.video_key) {
    throw new ApiError('Видео урока ещё не добавлено.', 404);
  }
  const object = await env.BUCKET.get(row.video_key);
  if (!object) {
    throw new ApiError('Видео урока недоступно.', 404);
  }
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'video/mp4',
      'cache-control': 'public, max-age=300',
    },
  });
}
