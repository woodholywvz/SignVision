import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = resolve(projectRoot, 'dist');
process.chdir(projectRoot);

// A build contains only generated files. Reject links before clearing stale output.
if (existsSync(outputDirectory)) {
  if (
    lstatSync(outputDirectory).isSymbolicLink() ||
    dirname(realpathSync(outputDirectory)) !== projectRoot
  ) {
    throw new Error('Build output must be a directory inside the project');
  }
  rmSync(outputDirectory, { recursive: true, force: true });
}

const sources = [
  ['/index.html', 'site/index.html', 'text/html; charset=utf-8'],
  ['/static/style.css', 'static/style.css', 'text/css; charset=utf-8'],
  ['/static/ui-refresh.css', 'static/ui-refresh.css', 'text/css; charset=utf-8'],
  ['/static/i18n.js', 'site/i18n.js', 'text/javascript; charset=utf-8'],
  ['/static/tracking.js', 'site/tracking.js', 'text/javascript; charset=utf-8'],
  ['/static/learning.js', 'site/learning.js', 'text/javascript; charset=utf-8'],
  ['/static/app.js', 'site/app.js', 'text/javascript; charset=utf-8'],
];
const revision = createHash('sha256')
  .update(
    sources
      .slice(1)
      .map(([, file]) => readFileSync(file))
      .join(''),
  )
  .digest('hex')
  .slice(0, 10);
const assets = Object.fromEntries(
  sources.map(([url, file, type]) => {
    let body = readFileSync(file, 'utf8');
    if (url === '/index.html') {
      body = body.replace(
        /\/static\/(style\.css|ui-refresh\.css|i18n\.js|tracking\.js|learning\.js|app\.js)/g,
        `/static/$1?v=${revision}`,
      );
    }
    return [url, { body, type }];
  }),
);
mkdirSync('dist/server', { recursive: true });
mkdirSync('dist/.openai', { recursive: true });
const config = JSON.parse(readFileSync('site/config.json', 'utf8'));
const worker =
  'const SITE_CONFIG = ' +
  JSON.stringify(config) +
  ';\nconst SITE_ASSETS = ' +
  JSON.stringify(assets) +
  ';\n' +
  readFileSync('site/email-auth.js', 'utf8') +
  '\n' +
  readFileSync('site/accounts.js', 'utf8') +
  '\n' +
  readFileSync('site/phrases.js', 'utf8') +
  '\n' +
  readFileSync('site/lessons.js', 'utf8') +
  '\n' +
  readFileSync('site/worker.js', 'utf8');
writeFileSync('dist/server/index.js', worker);
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
mkdirSync('dist/.openai/drizzle/meta', { recursive: true });
for (const file of readdirSync('drizzle').filter((name) => name.endsWith('.sql'))) {
  copyFileSync(`drizzle/${file}`, `dist/.openai/drizzle/${file}`);
}
for (const file of readdirSync('drizzle/meta')) {
  copyFileSync(`drizzle/meta/${file}`, `dist/.openai/drizzle/meta/${file}`);
}
console.log(`Built SignVision Site with ${sources.length} assets`);
