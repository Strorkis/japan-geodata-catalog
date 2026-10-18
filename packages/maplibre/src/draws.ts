/**
 * **MapLibre が描ける種類** (core の `engine.ts`)。3D Tiles は描けない (Three.js の層を重ねると描ける。packages/three)。
 * データの行 (DuckDB) は、引いたものを GeoJSON のソースに渡して描く (描き方は Web サイトの `ui/layers/`)。
 */
import type { Draws } from '@japan-geodata-catalog/core/engine';

export const MAPLIBRE_DRAWS = {
  query: true,
  'raster-tiles': true,
  style: true,
  'vector-tiles': true,
  'vector-points': true,
  '3d-tiles': false,
} as const satisfies Draws;
