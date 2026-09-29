import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

export const admin = {id: 'admin-user', email: 'admin@example.test', name: 'Admin'};
export const student = {id: 'student-user', email: 'student@example.test', name: 'Student'};

export function request(path, data, user = admin, method = data === undefined ? 'GET' : 'POST') {
  const headers = {};
  if (data !== undefined) headers['content-type'] = 'application/json';
  if (user) {
    headers['oai-authenticated-user-id'] = user.id;
    headers['oai-authenticated-user-email'] = user.email;
  }
  return new Request(`https://example.com${path}`, {method, headers, body: data === undefined ? undefined : JSON.stringify(data)});
}

export function environment({seedAdmin = true} = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('drizzle/0000_fresh_marvex.sql', 'utf8').replaceAll('--> statement-breakpoint', ''));
  if (seedAdmin) sqlite.prepare('INSERT INTO accounts (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(admin.id, admin.email, admin.name, 'admin', 1);
  const DB = {
    prepare(sql) {
      const args = [];
      return {
        bind(...values) { args.splice(0, args.length, ...values); return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return {results: sqlite.prepare(sql).all(...args)}; },
        async run() { const result = sqlite.prepare(sql).run(...args); return {meta: {changes: result.changes}}; },
      };
    },
  };
  const objects = new Map();
  const BUCKET = {
    async list({prefix = ''} = {}) { return {objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({key})), truncated: false}; },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {json: async () => JSON.parse(object.value), body: object.value, httpMetadata: object.metadata};
    },
    async put(key, value, options = {}) { objects.set(key, {value, metadata: options.httpMetadata || {}}); },
    async delete(key) { objects.delete(key); },
  };
  return {DB, BUCKET, sqlite, objects, BOOTSTRAP_ADMIN_EMAIL: admin.email};
}
