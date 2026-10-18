/**
 * **Navara が描ける種類** (core の `engine.ts`)。エンジンを読まずに引けるよう、ここは型だけに依る。
 *
 * - 背景地図 (XYZ)・3D Tiles・地形だけ。データの行 (DuckDB) はまだ描かない (TOBE)
 * - ベクトルタイルは URL のテンプレートで受けるので、PMTiles には中継が要る (Cesium の中継は Cesium の取得の口に差すもので、使い回せない)
 */
import type { Draws } from '@japan-geodata-catalog/core/engine';

export const NAVARA_DRAWS = {
  query: false,
  'raster-tiles': true,
  style: false,
  'vector-tiles': false,
  'vector-points': false,
  '3d-tiles': true,
} as const satisfies Draws;
