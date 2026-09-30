const BUILTIN_PHRASES = SITE_CONFIG.phrases;
const MAX_CUSTOM_PHRASES = 30;

async function phraseCatalog(db, includeArchived = false) {
  const [custom, archived] = await Promise.all([
    db.prepare('SELECT id, text_ru, text_en FROM custom_phrases ORDER BY created_at, id').all(),
    db.prepare('SELECT phrase_id, archived_at FROM archived_phrases').all(),
  ]);
  const archivedById = new Map(archived.results.map((item) => [item.phrase_id, item.archived_at]));
  return [
    ...BUILTIN_PHRASES.map((phrase) => ({ ...phrase, custom: false })),
    ...custom.results.map((phrase) => ({
      id: phrase.id,
      text: phrase.text_ru,
      en: phrase.text_en || phrase.text_ru,
      custom: true,
    })),
  ]
    .map((phrase) => ({ ...phrase, archived_at: archivedById.get(phrase.id) ?? null }))
    .filter((phrase) => includeArchived || phrase.archived_at === null);
}

function phraseIds(catalog) {
  return new Set(catalog.map((phrase) => phrase.id));
}

async function phraseOrThrow(db, id) {
  const phrase = (await phraseCatalog(db)).find((item) => item.id === id);
  if (!phrase) {
    throw new ApiError('Фраза не найдена.', 404);
  }
  return phrase;
}

async function createPhrase(request, env, data) {
  await requireAdmin(request, env.DB);
  const text = String(data.text || '')
    .trim()
    .replace(/\s+/g, ' ');
  const en = String(data.en || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) {
    throw new ApiError('Укажите название фразы.');
  }
  if (text.length > 80 || en.length > 80) {
    throw new ApiError('Название фразы должно быть не длиннее 80 символов.');
  }
  const nameKey = text.toLocaleLowerCase('ru');
  const catalog = await phraseCatalog(env.DB);
  const archived = (await phraseCatalog(env.DB, true)).find(
    (phrase) => phrase.archived_at !== null && phrase.text.toLocaleLowerCase('ru') === nameKey,
  );
  if (archived) {
    throw new ApiError('Такая фраза есть в удалённых. Восстановите её в словаре.', 409);
  }
  if (catalog.some((phrase) => phrase.text.toLocaleLowerCase('ru') === nameKey)) {
    throw new ApiError('Такая фраза уже существует.', 409);
  }
  if (catalog.filter((phrase) => phrase.custom).length >= MAX_CUSTOM_PHRASES) {
    throw new ApiError('Достигнут лимит новых фраз.', 413);
  }
  const id = `custom_${crypto.randomUUID().replaceAll('-', '')}`;
  const inserted = await env.DB.prepare(
    `INSERT INTO custom_phrases (id, text_ru, text_en, name_key, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(name_key) DO NOTHING`,
  )
    .bind(id, text, en, nameKey, Date.now())
    .run();
  if (!inserted.meta.changes) {
    throw new ApiError('Такая фраза уже существует.', 409);
  }
  return { id, text, en: en || text, custom: true };
}

async function archivePhrase(request, env, id) {
  const admin = await requireAdmin(request, env.DB);
  await phraseOrThrow(env.DB, id);
  await env.DB.prepare(
    'INSERT INTO archived_phrases (phrase_id, archived_at, archived_by) VALUES (?, ?, ?) ON CONFLICT(phrase_id) DO NOTHING',
  )
    .bind(id, Date.now(), admin.id)
    .run();
  sampleCache.delete(env.BUCKET);
  const catalog = await phraseCatalog(env.DB);
  return {
    removed: id,
    phrases: catalog,
    counts: counts(await samples(env.BUCKET, catalog), catalog),
  };
}

async function restorePhrase(request, env, id) {
  await requireAdmin(request, env.DB);
  const catalog = await phraseCatalog(env.DB, true);
  const phrase = catalog.find((item) => item.id === id && item.archived_at !== null);
  if (!phrase) {
    throw new ApiError('Фраза не найдена.', 404);
  }
  if (
    phrase.custom &&
    catalog.filter((item) => item.custom && item.archived_at === null).length >= MAX_CUSTOM_PHRASES
  ) {
    throw new ApiError('Достигнут лимит новых фраз.', 413);
  }
  await env.DB.prepare('DELETE FROM archived_phrases WHERE phrase_id = ?').bind(id).run();
  sampleCache.delete(env.BUCKET);
  return { restored: id };
}
