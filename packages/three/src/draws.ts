/**
 * **Three.js (MapLibre に重ねる層) が描ける種類** (core の `engine.ts`)。MapLibre の表と合わせて使う。
 * 描くのは 3D Tiles だけで、ほかの行は MapLibre が描く。エンジンを読まずに引けるよう、ここは型だけに依る。
 */
import type { Draws } from '@japan-geodata-catalog/core/engine';

export const THREE_DRAWS = {
  query: false,
  'raster-tiles': false,
  style: false,
  'vector-tiles': false,
  'vector-points': false,
  '3d-tiles': true,
} as const satisfies Draws;
