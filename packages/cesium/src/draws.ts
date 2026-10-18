/**
 * **Cesium が描ける種類** (core の `engine.ts`)。エンジンを読まずに引けるよう、ここは型だけに依る。
 *
 * - データの行 (DuckDB) はまだ描かない (TOBE)。スタイルの JSON (MapLibre GL) は読まない
 * - ベクトルタイルは PMTiles を中継して線と面を描く (`pmtiles.ts`)。点だけのテーマ (注記) は文字を描けないので描かない
 */
import type { Draws } from '@japan-geodata-catalog/core/engine';

export const CESIUM_DRAWS = {
  query: false,
  'raster-tiles': true,
  style: false,
  'vector-tiles': true,
  'vector-points': false,
  '3d-tiles': true,
} as const satisfies Draws;
