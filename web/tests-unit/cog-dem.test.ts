// COG の標高 (AW3D30) の並べ方から、読むファイルと段を選ぶ部品の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCog, cogUrl, tileBounds, type CogGrid } from '../src/lib/cog-dem.ts';

/** JAXA Earth API の AW3D30 と同じ並べ方。 */
const GRID: CogGrid = {
  template: 'https://example.invalid/{level}/{lon_band}/{tile}-DSM.tiff',
  levels: [
    { level: 0, tile_deg: 180, pixels: 900 },
    { level: 1, tile_deg: 90, pixels: 3600 },
    { level: 2, tile_deg: 10, pixels: 3600 },
    { level: 3, tile_deg: 1, pixels: 3600 },
  ],
  overviews: 2,
  nodata: -9999,
};

test('ファイル名は JAXA Earth API の形 (経度3桁・緯度2桁、小数2桁)', () => {
  assert.equal(
    cogUrl(GRID, 3, 1, 139, 35),
    'https://example.invalid/3/E139.00-E140.00/E139.00-N35.00-E140.00-N36.00-DSM.tiff',
  );
  assert.equal(
    cogUrl(GRID, 0, 180, -180, -90),
    'https://example.invalid/0/W180.00-E000.00/W180.00-S90.00-E000.00-N90.00-DSM.tiff',
  );
});

test('画面より粗くならない中で、いちばん粗い段と縮小版を選ぶ', () => {
  // 段3の原寸 (1/3600°) と縮小版 (1/1800°, 1/900°) のうち、1/1000° より細かいものでいちばん粗いのは 1/1800°。
  const c = chooseCog(GRID, 1 / 1000);
  assert.equal(c.level, 3);
  assert.equal(c.overview, 1);
  // 引いた表示 (1画素が 0.5°) なら、段0の 1/4 縮小版 (0.8°) は粗すぎるので 1/2 (0.4°)。
  const far = chooseCog(GRID, 0.5);
  assert.equal(far.level, 0);
  assert.equal(far.overview, 1);
  // 寄りすぎ (原寸より細かい) なら、いちばん細かいもの。
  const near = chooseCog(GRID, 1e-6);
  assert.deepEqual([near.level, near.overview], [3, 0]);
});

test('地図のタイルの範囲 (Web メルカトル)', () => {
  const b = tileBounds(1, 1, 0);
  assert.equal(b.west, 0);
  assert.equal(b.east, 180);
  assert.equal(b.south, 0);
  assert.ok(Math.abs(b.north - 85.0511) < 1e-3);
});
