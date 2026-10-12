// 吹き出しの中身 (src/ui/hover-rows) の単体テスト。MapLibre と Cesium が同じものを出すので、地図に依らずここで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorHover } from '../src/ui/hover-rows.ts';
import type { Collection } from '../src/lib/stac.ts';

/** 地理院の最適化ベクトルタイルの Collection のうち、吹き出しが使うところだけ。 */
const GSI = {
  title: '最適化ベクトルタイル',
  vintage: '2026-07-01 時点',
  group: { title: '国土地理院' },
  themes: [
    {
      id: 'road',
      title: '道路',
      layers: [{ id: 'RdCL', title: '道路中心線', minzoom: 4, maxzoom: 16, fields: [] }],
    },
  ],
} as unknown as Collection;

test('地物の名前が無ければ、見出しは「テーマ › 層」', () => {
  const hover = vectorHover(GSI, 'RdCL', { vt_code: 2701 });
  assert.deepEqual(hover.rows, [
    ['', '道路 › 道路中心線'],
    ['層', '道路中心線 (RdCL)'],
    ['種別コード', '2701'],
    ['出所', '国土地理院 最適化ベクトルタイル'],
    ['時点', '2026-07-01 時点'],
  ]);
});

test('注記の文字があれば見出しにし、無い値の行は出さない (null)', () => {
  const hover = vectorHover(GSI, 'RdCL', { vt_text: '国道1号' });
  assert.equal(hover.rows[0][1], '国道1号');
  assert.equal(hover.rows[2][1], null);
});

test('同じ地物なら鍵が同じ (作り直さない)、違えば違う', () => {
  assert.equal(vectorHover(GSI, 'RdCL', { vt_code: 1 }).key, vectorHover(GSI, 'RdCL', { vt_code: 1 }).key);
  assert.notEqual(vectorHover(GSI, 'RdCL', { vt_code: 1 }).key, vectorHover(GSI, 'RdCL', { vt_code: 2 }).key);
});
