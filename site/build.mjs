import {readFileSync, mkdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const sources = [
  ['/index.html', 'site/index.html', 'text/html; charset=utf-8'],
  ['/static/style.css', 'static/style.css', 'text/css; charset=utf-8'],
  ['/static/i18n.js', 'site/i18n.js', 'text/javascript; charset=utf-8'],
  ['/static/tracking.js', 'site/tracking.js', 'text/javascript; charset=utf-8'],
  ['/static/learning.js', 'site/learning.js', 'text/javascript; charset=utf-8'],
  ['/static/app.js', 'site/app.js', 'text/javascript; charset=utf-8'],
];
const revision = createHash('sha256').update(sources.slice(1).map(([, file]) => readFileSync(file)).join('')).digest('hex').slice(0, 10);
const assets = Object.fromEntries(sources.map(([url, file, type]) => {
  let body = readFileSync(file, 'utf8');
  if (url === '/index.html') body = body.replace(/\/static\/(style\.css|i18n\.js|tracking\.js|learning\.js|app\.js)/g, `/static/$1?v=${revision}`);
  return [url, {body, type}];
}));
mkdirSync('dist/server', {recursive: true});
mkdirSync('dist/.openai', {recursive: true});
const config = JSON.parse(readFileSync('site/config.json', 'utf8'));
const worker = 'const SITE_CONFIG = ' + JSON.stringify(config) + ';\nconst SITE_ASSETS = ' + JSON.stringify(assets) + ';\n' +
  readFileSync('site/accounts.js', 'utf8') + '\n' + readFileSync('site/lessons.js', 'utf8') + '\n' + readFileSync('site/worker.js', 'utf8');
writeFileSync('dist/server/index.js', worker);
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log(`Built SignVision Site with ${sources.length} assets`);
