/**
 * **COG (Cloud Optimized GeoTIFF) の標高を、地図の地形タイルにする。** AW3D30 (JAXA) のため。
 *
 * MapLibre は COG をそのまま読めないので、地理院の標高と同じく独自のプロトコルで受け、
 * 頼まれた地図のタイル (Web メルカトル) の範囲を COG から読んで Terrarium 形式の画像にして返す。
 * 地形 (立体) にも陰影にも、MapLibre の仕組みがそのまま使える。
 *
 * COG は経緯度 (EPSG:4326) の格子で、段ごとに1つのファイルが覆う範囲が違う (JAXA Earth API の並べ方)。
 * ファイルの中にも縮小版 (オーバービュー) がある。**表示の細かさに見合う段と縮小版を選び、要る窓だけを読む**
 * (geotiff.js が HTTP Range で読む)。並べ方はカタログの `duck:cog_grid` から読む (ここに決め打ちしない)。
 */
import { fromUrl, type GeoTIFF } from 'geotiff';

/** COG の並べ方 (カタログの `duck:cog_grid`)。 */
export interface CogGrid {
  /** ファイルの URL。`{level}`・`{lon_band}` (`E139.00-E140.00`)・`{tile}` (`E139.00-N35.00-E140.00-N36.00`) を置き換える。 */
  template: string;
  /** 段ごとに、1つのファイルが覆う広さ (度) と1辺の画素数。 */
  levels: { level: number; tile_deg: number; pixels: number }[];
  /** ファイルの中の縮小版の数 (1/2・1/4 …)。 */
  overviews: number;
  /** 値の無い画素の値 (海など)。0 m として描く。 */
  nodata: number;
}

/** 選んだ読み方 (段・縮小版・画素の細かさ)。 */
export interface CogChoice {
  level: number;
  tileDeg: number;
  /** ファイルの中の何番目の画像か (0 が原寸、1 が 1/2 …)。 */
  overview: number;
  /** 1画素の大きさ (度)。 */
  resolution: number;
}

/**
 * 地図のタイル1画素の大きさ (度) に見合う読み方を選ぶ。**画面より粗くならない中でいちばん粗いもの**。
 * どれも画面より粗ければ (寄りすぎ)、いちばん細かいもの。
 */
export function chooseCog(grid: CogGrid, degreesPerPixel: number): CogChoice {
  const candidates = grid.levels.flatMap(({ level, tile_deg, pixels }) =>
    Array.from({ length: grid.overviews + 1 }, (_, overview) => ({
      level,
      tileDeg: tile_deg,
      overview,
      resolution: (tile_deg / pixels) * 2 ** overview,
    })),
  );
  const fine = candidates.filter((c) => c.resolution <= degreesPerPixel);
  if (fine.length > 0) return fine.reduce((a, b) => (b.resolution > a.resolution ? b : a));
  return candidates.reduce((a, b) => (b.resolution < a.resolution ? b : a));
}

/** `E139.00` / `W090.00` / `N35.00` / `S90.00` の形 (JAXA Earth API のファイル名)。 */
const lonLabel = (lon: number) => `${lon < 0 ? 'W' : 'E'}${Math.abs(lon).toFixed(2).padStart(6, '0')}`;
const latLabel = (lat: number) => `${lat < 0 ? 'S' : 'N'}${Math.abs(lat).toFixed(2).padStart(5, '0')}`;

/** 南西の角 (度) からファイルの URL を作る。 */
export function cogUrl(grid: CogGrid, level: number, tileDeg: number, west: number, south: number): string {
  const east = west + tileDeg;
  const north = south + tileDeg;
  return grid.template
    .replace('{level}', String(level))
    .replace('{lon_band}', `${lonLabel(west)}-${lonLabel(east)}`)
    .replace('{tile}', `${lonLabel(west)}-${latLabel(south)}-${lonLabel(east)}-${latLabel(north)}`);
}

/** Web メルカトルのタイルの範囲 (度)。 */
export function tileBounds(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

/** 開いた COG (URL ごと)。無いファイル (海だけの所) は null を覚えておき、取りに行かない。 */
const opened = new Map<string, Promise<GeoTIFF | null>>();
const open = (url: string) => {
  let tiff = opened.get(url);
  if (!tiff) {
    // **展開した内部タイルをためる** (`cache`)。隣り合う地図のタイルは同じ内部タイルを読むので、
    // ためないと読み込みの回数が地図のタイルの数だけ増える (富士山 z11 で 848回だった)。
    // (`fromUrl` は `cache` を受け取らないので、開いてから立てる。画像を取り出すときにこれを見る。)
    // **64KB のブロックで読み、読んだブロックを使い回す** (`blockSize`)。指定しないと、内部タイルの位置の表を
    // 1項目 (4バイト) ずつ別々に読みに行く (内部タイル1つにつき3回。富士山 z11 で 1,403回だった)。
    // (型の定義には blockSize・cacheSize が無いが、makeRemoteSource が読んで BlockedSource を挟む。)
    tiff = fromUrl(url, { allowFullFile: false, blockSize: 65536, cacheSize: 512 } as Parameters<typeof fromUrl>[1])
      .then((opened) => {
        opened.cache = true;
        return opened;
      })
      .catch(() => null);
    opened.set(url, tiff);
  }
  return tiff;
};

/**
 * 地図のタイル1枚ぶんの高さ (m、`size`×`size`、行は北から)。値の無い所とファイルの無い所は 0。
 */
export async function demTile(
  grid: CogGrid,
  z: number,
  x: number,
  y: number,
  size: number,
): Promise<Float32Array> {
  const bounds = tileBounds(z, x, y);
  const choice = chooseCog(grid, (bounds.east - bounds.west) / size);
  const { tileDeg } = choice;

  // タイルに掛かるファイル (南西の角)。経度は -180、緯度は -90 から tileDeg ごと。
  const corners: [number, number][] = [];
  const first = (v: number, origin: number) => Math.floor((v - origin) / tileDeg) * tileDeg + origin;
  for (let w = first(bounds.west, -180); w < bounds.east; w += tileDeg) {
    for (let s = first(bounds.south, -90); s < bounds.north; s += tileDeg) corners.push([w, s]);
  }

  // ファイルごとに、タイルに掛かる窓を読む。
  const windows = await Promise.all(
    corners.map(async ([west, south]) => {
      const tiff = await open(cogUrl(grid, choice.level, tileDeg, west, south));
      if (!tiff) return null;
      const image = await tiff.getImage(choice.overview);
      const width = image.getWidth();
      const height = image.getHeight();
      const north = south + tileDeg;
      // **画素の大きさはファイルの実際の幅から求める** (カタログの画素数がずれていても位置は狂わない。
      // 段 1・2 を 900 画素と書いていて、引いた表示が東へずれたことがある)。
      const resolution = tileDeg / width;
      const x0 = Math.max(0, Math.floor((bounds.west - west) / resolution));
      const x1 = Math.min(width, Math.ceil((bounds.east - west) / resolution));
      const y0 = Math.max(0, Math.floor((north - bounds.north) / resolution));
      const y1 = Math.min(height, Math.ceil((north - bounds.south) / resolution));
      if (x0 >= x1 || y0 >= y1) return null;
      // **中断しない** (`signal` を渡さない)。ためた内部タイルが読みかけのまま残り、展開に失敗する
      // ("buffer error")。要らなくなったタイルでも、読み終えたものは次に使える。
      const [band] = (await image.readRasters({ window: [x0, y0, x1, y1] })) as unknown as ArrayLike<number>[];
      return { west, north, x0, y0, width: x1 - x0, height: y1 - y0, band, resolution };
    }),
  );

  // タイルの画素ごとに、その経緯度の COG の画素を引く (最も近いもの)。
  const heights = new Float32Array(size * size);
  const n = 2 ** z;
  for (let row = 0; row < size; row++) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (row + 0.5) / size)) / n))) * 180) / Math.PI;
    for (let col = 0; col < size; col++) {
      const lon = bounds.west + ((col + 0.5) / size) * (bounds.east - bounds.west);
      let value = 0;
      for (const w of windows) {
        if (!w) continue;
        const px = Math.floor((lon - w.west) / w.resolution) - w.x0;
        const py = Math.floor((w.north - lat) / w.resolution) - w.y0;
        if (px < 0 || py < 0 || px >= w.width || py >= w.height) continue;
        const v = w.band[py * w.width + px];
        value = v === grid.nodata ? 0 : v;
        break;
      }
      heights[row * size + col] = value;
    }
  }
  return heights;
}
