import {readFileSync, mkdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';

const sources = [
  ['/index.html', 'site/index.html', 'text/html; charset=utf-8'],
  ['/static/style.css', 'static/style.css', 'text/css; charset=utf-8'],
  ['/static/i18n.js', 'site/i18n.js', 'text/javascript; charset=utf-8'],
  ['/static/tracking.js', 'site/tracking.js', 'text/javascript; charset=utf-8'],
  ['/static/app.js', 'site/app.js', 'text/javascript; charset=utf-8'],
];
const assets = Object.fromEntries(sources.map(([url, file, type]) => [url, {body: readFileSync(file, 'utf8'), type}]));
mkdirSync('dist/server', {recursive: true});
mkdirSync('dist/.openai', {recursive: true});
const config = JSON.parse(readFileSync('site/config.json', 'utf8'));
const worker = 'const SITE_CONFIG = ' + JSON.stringify(config) + ';\nconst SITE_ASSETS = ' + JSON.stringify(assets) + ';\n' + readFileSync('site/worker.js', 'utf8');
writeFileSync('dist/server/index.js', worker);
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log(`Built SignVision Site with ${sources.length} assets`);
