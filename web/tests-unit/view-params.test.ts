// 地図の見え方を URL で渡す部品 (src/lib/view-params) の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readView, viewParams } from '../src/lib/view-params.ts';

const FALLBACK = { zoom: 15, pitch: 50, bearing: 0 };

test('書いた見え方を、そのまま読み戻せる', () => {
  const view = { lon: 139.76712, lat: 35.68123, zoom: 16.25, pitch: 60, bearing: -30 };
  assert.deepEqual(readView(`?${viewParams(view)}`, FALLBACK), view);
});

test('位置が無い・壊れている URL は読まない (いつもの初期表示にする)', () => {
  assert.equal(readView('', FALLBACK), undefined);
  assert.equal(readView('?lon=139.7', FALLBACK), undefined);
  assert.equal(readView('?lon=abc&lat=35', FALLBACK), undefined);
  assert.equal(readView('?lon=&lat=35', FALLBACK), undefined);
  assert.equal(readView('?lon=139&lat=91', FALLBACK), undefined);
});

test('位置だけなら、ほかは既定の値。傾きは 0〜85° に収める', () => {
  assert.deepEqual(readView('?lon=139&lat=35', FALLBACK), { lon: 139, lat: 35, ...FALLBACK });
  assert.equal(readView('?lon=139&lat=35&pitch=120', FALLBACK)?.pitch, 85);
  assert.equal(readView('?lon=139&lat=35&pitch=-5', FALLBACK)?.pitch, 0);
});
