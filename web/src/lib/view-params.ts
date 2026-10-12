/**
 * **地図の見え方。** URL で場所を渡すときと、地図のエンジン (MapLibre ⇄ Cesium) を切り替えるときに使う。
 *
 * 意味は MapLibre に合わせる (ズームは 512 画素のタイル、傾きは真上からの度、向きは北から時計回りの度)。
 * Cesium 側でカメラの距離に直す (lib/engines/cesium.ts)。
 */
export interface View {
  lon: number;
  lat: number;
  zoom: number;
  /** 傾き (度)。0 で真上から。 */
  pitch: number;
  /** 向き (度)。0 で北が上。 */
  bearing: number;
}

/** URL の `lon`・`lat` (と `zoom`・`pitch`・`bearing`) を読む。位置が無いか壊れていれば undefined。 */
export function readView(search: string, fallback: Omit<View, 'lon' | 'lat'>): View | undefined {
  const p = new URLSearchParams(search);
  const num = (key: string) => {
    const raw = p.get(key);
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const lon = num('lon');
  const lat = num('lat');
  if (lon === undefined || lat === undefined || Math.abs(lat) > 85 || Math.abs(lon) > 180) return undefined;
  return {
    lon,
    lat,
    zoom: num('zoom') ?? fallback.zoom,
    pitch: Math.max(0, Math.min(85, num('pitch') ?? fallback.pitch)),
    bearing: num('bearing') ?? fallback.bearing,
  };
}

/** `readView` で読める形の URL の引数にする (桁は場所が分かる程度に丸める)。 */
export function viewParams(view: View): URLSearchParams {
  return new URLSearchParams({
    lon: view.lon.toFixed(5),
    lat: view.lat.toFixed(5),
    zoom: view.zoom.toFixed(2),
    pitch: view.pitch.toFixed(0),
    bearing: view.bearing.toFixed(0),
  });
}
