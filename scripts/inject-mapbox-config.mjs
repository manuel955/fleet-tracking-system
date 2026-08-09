import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const output = path.join(
  projectRoot,
  'dashboard',
  'js',
  'mapbox-runtime-config.generated.js',
);

const token = process.env.MAPBOX_ACCESS_TOKEN || '';
const style = process.env.MAPBOX_STYLE_URI || 'mapbox://styles/mapbox/standard';

fs.writeFileSync(
  output,
  [
    `window.__MAPBOX_ACCESS_TOKEN__ = ${JSON.stringify(token)};`,
    `window.__MAPBOX_STYLE_URI__ = ${JSON.stringify(style)};`,
    '',
  ].join('\n'),
  'utf8',
);

if (!token) {
  console.warn('MAPBOX_ACCESS_TOKEN esta vacio; el dashboard mostrara un estado seguro.');
} else {
  console.log(`Configuracion Mapbox generada en ${output}`);
}
