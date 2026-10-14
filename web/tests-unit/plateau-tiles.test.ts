// PLATEAU 配信サービスの 3D Tiles の spec (`<範囲>-<種類>-<LOD>[-interior][-<テクスチャ>]-<年>`) の組み替え。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plateauTilesChoice, plateauTilesetUrl } from '../src/lib/plateau-tiles.ts';

const API = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';

test('カタログの URL から、いまの組み合わせを読む', () => {
  assert.deepEqual(plateauTilesChoice(`${API}/all-bldg-maxlod2-latest/tileset.json`), { lod: 'maxlod2', texture: 'preferred' });
  assert.deepEqual(plateauTilesChoice(`${API}/13101-bldg-lod1-notexture-2025/tileset.json`), { lod: 'lod1', texture: 'notexture' });
});

test('LOD とテクスチャを替える (範囲・種類・年はそのまま)', () => {
  const href = `${API}/all-bldg-maxlod2-latest/tileset.json`;
  assert.equal(plateauTilesetUrl(href, { lod: 'lod1', texture: 'notexture' }), `${API}/all-bldg-lod1-notexture-latest/tileset.json`);
  assert.equal(plateauTilesetUrl(href, { lod: 'maxlod3', texture: 'preferred' }), `${API}/all-bldg-maxlod3-latest/tileset.json`);
  // 屋内 (interior) は残す。
  assert.equal(
    plateauTilesetUrl(`${API}/13101-bldg-lod3-interior-2025/tileset.json`, { lod: 'lod1', texture: 'notexture' }),
    `${API}/13101-bldg-lod1-interior-notexture-2025/tileset.json`,
  );
});

test('PLATEAU の組み立ての形でなければ触らない', () => {
  const reearth = 'https://buildings.reearth.land/tileset.json';
  assert.equal(plateauTilesChoice(reearth), undefined);
  assert.equal(plateauTilesetUrl(reearth, { lod: 'lod1', texture: 'notexture' }), reearth);
});
