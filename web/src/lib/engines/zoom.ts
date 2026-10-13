/**
 * **MapLibre のズームと、注視点からカメラまでの距離 (m) の行き来。** 地図を入れ替えるエンジン (Cesium・Navara) が、
 * 見え方の正本 (MapLibre) に合わせてカメラを置くのに使う。
 */

/** 赤道の1周 (m)。MapLibre のズームの元。 */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

const metersPerPixel = (zoom: number, lat: number) =>
  (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

/**
 * MapLibre のズームを距離にする。MapLibre の画面の縦の広さ (画素 × 1画素の m) が、縦の画角 `fovy` (ラジアン) に収まる距離。
 * 傾けても注視点からの距離は変わらない (MapLibre と同じ)。
 */
export const rangeForZoom = (zoom: number, lat: number, viewportHeight: number, fovy: number) =>
  ((viewportHeight / 2) * metersPerPixel(zoom, lat)) / Math.tan(fovy / 2);

/** `rangeForZoom` の逆。 */
export const zoomForRange = (range: number, lat: number, viewportHeight: number, fovy: number) =>
  Math.log2(
    (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180) * (viewportHeight / 2)) / (512 * range * Math.tan(fovy / 2)),
  );
