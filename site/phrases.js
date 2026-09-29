const BUILTIN_PHRASES = SITE_CONFIG.phrases;
const MAX_CUSTOM_PHRASES = 30;

async function phraseCatalog(db) {
  const custom = (await db.prepare('SELECT id, text_ru, text_en FROM custom_phrases ORDER BY created_at, id').all()).results;
  return [
    ...BUILTIN_PHRASES.map(phrase => ({...phrase, custom: false})),
    ...custom.map(phrase => ({id: phrase.id, text: phrase.text_ru, en: phrase.text_en || phrase.text_ru, custom: true})),
  ];
}

function phraseIds(catalog) { return new Set(catalog.map(phrase => phrase.id)); }

async function phraseOrThrow(db, id) {
  const phrase = (await phraseCatalog(db)).find(item => item.id === id);
  if (!phrase) throw new ApiError('Фраза не найдена.', 404);
  return phrase;
}

async function createPhrase(request, env, data) {
  await requireAdmin(request, env.DB);
  const text = String(data.text || '').trim().replace(/\s+/g, ' ');
  const en = String(data.en || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new ApiError('Укажите название фразы.');
  if (text.length > 80 || en.length > 80) throw new ApiError('Название фразы должно быть не длиннее 80 символов.');
  const nameKey = text.toLocaleLowerCase('ru');
  const catalog = await phraseCatalog(env.DB);
  if (catalog.some(phrase => phrase.text.toLocaleLowerCase('ru') === nameKey)) throw new ApiError('Такая фраза уже существует.', 409);
  if (catalog.length - BUILTIN_PHRASES.length >= MAX_CUSTOM_PHRASES) throw new ApiError('Достигнут лимит новых фраз.', 413);
  const id = `custom_${crypto.randomUUID().replaceAll('-', '')}`;
  const inserted = await env.DB.prepare(`INSERT INTO custom_phrases (id, text_ru, text_en, name_key, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(name_key) DO NOTHING`).bind(id, text, en, nameKey, Date.now()).run();
  if (!inserted.meta.changes) throw new ApiError('Такая фраза уже существует.', 409);
  return {id, text, en: en || text, custom: true};
}
