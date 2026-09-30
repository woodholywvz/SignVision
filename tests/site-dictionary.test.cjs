const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

function dictionaryContext(admin = true) {
  const source = fs.readFileSync('site/app.js', 'utf8');
  const elements = new Map();
  const node = () => ({
    children: [],
    handlers: {},
    value: '',
    classList: { toggle() {} },
    setAttribute() {},
    focus() {},
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = items;
    },
    addEventListener(event, handler) {
      this.handlers[event] = handler;
    },
  });
  const context = vm.createContext({
    phrases: [
      { id: 'privet', text: 'Привет' },
      { id: 'spasibo', text: 'Спасибо' },
    ],
    counts: { privet: 1, spasibo: 0 },
    phraseDeletion: null,
    locale: 'ru',
    document: { createElement: node },
    $: (id) => {
      if (!elements.has(id)) {
        elements.set(id, node());
      }
      return elements.get(id);
    },
    t: (key) => key,
    countText: (value) => String(value),
    phraseName: (id) => id,
    renderHomeStatus() {},
    applyLocale() {},
    AbortController,
    setTimeout,
    clearTimeout,
    window: {
      SignVisionLearning: { isAdmin: () => admin, async refreshLessons() {}, async loadAdmin() {} },
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf('function renderCatalog()'),
      source.indexOf('function renderHomeStatus()'),
    ),
    context,
  );
  vm.runInContext(
    source.slice(
      source.indexOf("$('confirmDeletePhraseButton').addEventListener"),
      source.indexOf("$('newPhraseForm').addEventListener"),
    ),
    context,
  );
  return { context, elements };
}

test('dictionary shows delete actions to admins and waits for explicit confirmation', async () => {
  const { context, elements } = dictionaryContext();
  let requests = 0;
  context.fetch = async (url, { method }) => {
    requests++;
    assert.equal(method, 'DELETE');
    assert.equal(url, '/api/admin/phrases/privet');
    return {
      ok: true,
      json: async () => ({ phrases: [{ id: 'spasibo' }], counts: { spasibo: 0 } }),
    };
  };
  context.renderCatalog();
  const remove = elements.get('phraseGrid').children[0].children[1];
  assert.equal(remove.textContent, 'deletePhrase');
  remove.onclick();
  assert.equal(context.phraseDeletion.id, 'privet');
  assert.equal(elements.get('phraseDeletePrompt').hidden, false);
  assert.equal(requests, 0);
  elements.get('cancelDeletePhraseButton').handlers.click();
  assert.equal(context.phraseDeletion, null);
  assert.equal(requests, 0);
  elements.get('phraseGrid').children[0].children[1].onclick();
  await elements.get('confirmDeletePhraseButton').handlers.click();
  assert.equal(requests, 1);
  assert.equal(context.phrases.length, 1);
  assert.equal(context.phraseDeletion, null);
  assert.equal(elements.get('phraseDeleteStatus').textContent, 'phraseDeleted');
});

test('dictionary reports deletion failures beside the confirmation and keeps the phrase', async () => {
  const { context, elements } = dictionaryContext();
  context.fetch = async () => ({ ok: false, json: async () => ({ detail: 'Access denied' }) });
  context.renderCatalog();
  elements.get('phraseGrid').children[0].children[1].onclick();
  await context.deleteDictionaryPhrase();
  assert.equal(context.phrases.length, 2);
  assert.equal(context.phraseDeletion.pending, false);
  assert.equal(elements.get('phraseDeleteError').textContent, 'Access denied');
});

test('student dictionary has no delete buttons or deletion requests', async () => {
  const { context, elements } = dictionaryContext(false);
  let requests = 0;
  context.fetch = async () => {
    requests++;
  };
  context.renderCatalog();
  assert.equal(elements.get('phraseGrid').children[0].className, 'phrase-card');
  context.phraseDeletion = { id: 'privet', pending: false };
  await context.deleteDictionaryPhrase();
  assert.equal(requests, 0);
});
