import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { HANDWRITING_FONTS, DEFAULT_SETTINGS, findFont } from './handwriting/catalog';
import { findProject, type LatexProjectNode, type LatexRootNode } from './latexProjects';
import { enhancePixels, isSaneQuad as isScannerQuad, NEUTRAL_ADJUSTMENTS, type ScanFilterId } from './scannerFilters';
import { isSaneQuad as isDetectionQuad } from './edgeDetector';

test('self-hosted font assets match the selectable catalog without orphaned files or missing subsets', () => {
  const directory = new URL('../../public/fonts/handwriting/', import.meta.url);
  const css = readFileSync(new URL('fonts.css', directory), 'utf8');
  const families = new Set([...css.matchAll(/font-family:'([^']+)'/g)].map(match => match[1]));
  const referencedFiles = new Set([...css.matchAll(/url\('\/fonts\/handwriting\/([^']+)'\)/g)].map(match => match[1]));
  const fontFiles = new Set(readdirSync(directory).filter(file => file.endsWith('.woff2')));
  assert.deepEqual(families, new Set(HANDWRITING_FONTS.map(font => font.family)));
  assert.deepEqual(referencedFiles, fontFiles);
  for (const file of referencedFiles) assert.ok(readFileSync(new URL(file, directory)).length > 0, `${file} is empty`);
  assert.equal(findFont('unsupported-font-family'), findFont(DEFAULT_SETTINGS.fontFamily));
});

const filterHashes: Record<ScanFilterId, string> = {
  original: 'd918770bb0d5e477bd9215b3032620c6405f051d0852d12dba80a332d5fa807b',
  superscan: '946a99fe9ed015521e802ee81dad4ddb8e86cc189cea3883b9164b69b40143f9',
  magic: '85617ebee0ffedaa46365034178ddf4d83c366dc9892e828843c535b6172b9e3',
  gray: 'f4e8abe6f9a601d4cba19e51dd5d538878ef5ff3c98035d2f508f91f90bc9047',
};

for (const filter of Object.keys(filterHashes) as ScanFilterId[]) {
  test(`${filter} filter retains its pre-cleanup pixel output`, () => {
    const pixels = Uint8ClampedArray.from(
      { length: 32 * 24 * 4 },
      (_, i) => i % 4 === 3 ? 255 : (i * 37 + Math.floor(i / 17) * 11) % 256,
    );
    enhancePixels(pixels, 32, 24, filter, NEUTRAL_ADJUSTMENTS);
    assert.equal(createHash('sha256').update(pixels).digest('hex'), filterHashes[filter]);
  });
}

test('shared project lookup preserves root, nested, missing, and first-match semantics', () => {
  const project = (id: string): LatexProjectNode => ({ id, kind: 'project', name: id, files: [], createdAt: 0, updatedAt: 0 });
  const root = project('root');
  const nested = project('nested');
  const tree: LatexRootNode[] = [root, { id: 'folder', kind: 'folder', name: 'Folder', projects: [nested, project('root')] }];
  assert.equal(findProject(tree, 'root'), root);
  assert.equal(findProject(tree, 'nested'), nested);
  assert.equal(findProject(tree, 'missing'), null);
  assert.equal(findProject(tree, 'folder'), null);
  assert.equal(findProject([], 'root'), null);
});

test('scanner and detector quad validators keep their deliberately different thresholds', () => {
  const small = { tl: { x: 0.2, y: 0.2 }, tr: { x: 0.3, y: 0.2 }, br: { x: 0.3, y: 0.3 }, bl: { x: 0.2, y: 0.3 } };
  assert.equal(isDetectionQuad(small), true);
  assert.equal(isScannerQuad(small), false);
  const page = { tl: { x: 0.1, y: 0.1 }, tr: { x: 0.9, y: 0.1 }, br: { x: 0.9, y: 0.9 }, bl: { x: 0.1, y: 0.9 } };
  assert.equal(isDetectionQuad(page), true);
  assert.equal(isScannerQuad(page), true);
});
