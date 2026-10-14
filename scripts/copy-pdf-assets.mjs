import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {mkdir,cp} from 'node:fs/promises';
const require=createRequire(import.meta.url),source=dirname(require.resolve('pdfjs-dist/package.json'));
for(const folder of ['cmaps','standard_fonts','wasm']){await mkdir('public/pdf-assets',{recursive:true});await cp(join(source,folder),join('public/pdf-assets',folder),{recursive:true});}
