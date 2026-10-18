/**
 * **deck.gl が描ける種類** (core の `engine.ts`)。MapLibre に重ねるので、MapLibre の表と合わせて使う。
 * 描くのは建物 (DuckDB の行) と地形だけで、ほかの行は MapLibre が描く。エンジンを読まずに引けるよう、ここは型だけに依る。
 */
import type { Draws } from '@japan-geodata-catalog/core/engine';

export const DECKGL_DRAWS = {
  query: true,
  'raster-tiles': false,
  style: false,
  'vector-tiles': false,
  'vector-points': false,
  '3d-tiles': false,
} as const satisfies Draws;
