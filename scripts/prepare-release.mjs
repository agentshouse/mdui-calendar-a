import fs from 'node:fs';
import './generate-notices.mjs';
for (const name of ['app.json', 'schema.yaml']) fs.copyFileSync(name, `public/${name}`);
fs.copyFileSync('LICENSE', 'public/LICENSE.txt');
