/**
 * **Navara のエンジン** (Re:Earth の地図エンジン。three.js の上に Rust/WASM の中身)。Cesium と同じく、地図 (MapLibre) と
 * 同じページでバーから入れ替えて使う (docs/roadmap.md「行き先」)。
 *
 * - **一覧の状態から描く** (`sync`)。描けるのは背景地図 (XYZ)・3D Tiles・地形。ベクトルタイルとデータの行 (DuckDB) はまだ描かない (TOBE)。
 *   ベクトルタイルは URL のテンプレートで受けるので、PMTiles には中継が要る (Cesium の中継は Cesium の取得の口に差すもので、使い回せない)
 * - **見え方の正本は MapLibre。** カメラが止まるたびに `onMoveEnd` で知らせ、呼ぶ側が (隠れている) MapLibre を合わせる
 * - **一度作ったら壊さない。** 隠すときは入れ物を隠すだけ (変化があったときだけ描くので、隠れている間は描かない)
 * - **写真のような空 (`addDefaultPhotorealScene`) は使わない。** 大気の描画のテクスチャ (約10MB) を読みに行き、地図の色も変わる。
 *   光は全体を照らすもの (ambient) と太陽だけ
 * - 地形は Cesium と同じく**楕円体高の quantized-mesh** (Re:Earth Terrain)。3D Tiles も楕円体高なので、建物が地面に乗る
 */
import ThreeView, { type Layer, type Source } from '@navaramap/three';
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin';
import type { Collection } from '../stac';
import type { View } from '../view-params';
import { rangeForZoom, zoomForRange } from './zoom';

/** 一覧の行のうち、Navara で描くもの。**上の行ほど上** (一覧の並び) で渡す。 */
export type NavaraRow =
  | { kind: 'raster'; collection: Collection; opacity: number }
  | { kind: '3d_tiles'; collection: Collection };

export interface NavaraTerrainChoice {
  enabled: boolean;
  /** 地形の欄で選んでいる標高。quantized-mesh を持たなければ、持つもの (Re:Earth Terrain) に替える。 */
  selected: Collection | undefined;
}

export interface NavaraEngine {
  /** 出す。MapLibre の見え方からカメラを置く。 */
  show: (view: View) => Promise<void>;
  /** 隠す (壊さない)。 */
  hide: () => void;
  /** いまの見え方 (MapLibre の形に直したもの)。 */
  view: () => View;
  /** 一覧の状態を写す。**使う地形** (選んだ標高の代わりに替えたものを含む。平らなら undefined) を返す。 */
  sync: (rows: NavaraRow[], terrain: NavaraTerrainChoice) => Collection | undefined;
  /** E2E のための足がかり。 */
  navara: ThreeView<DefaultDescriptions>;
}

export interface NavaraEngineOptions {
  /** 入れ物 (地図と同じ場所に重ねる)。 */
  container: HTMLElement;
  /** 地形に使える quantized-mesh を持つ Collection (カタログの `rel: quantized-mesh`)。 */
  quantizedMeshTerrains: Collection[];
  /** カメラが止まったとき (MapLibre を合わせるため)。 */
  onMoveEnd: (view: View) => void;
}

/** 縦の画角 (度。Navara の既定と同じ)。 */
const FOV_DEG = 50;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

// ---- WGS84 の地心座標 (ECEF) との行き来。Navara の内部の軸の向きに依らないよう、自前で持つ ----
const WGS84_A = 6378137;
const WGS84_B = 6356752.314245;
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
type Vec3 = [number, number, number];

function toEcef(lon: number, lat: number, height: number): Vec3 {
  const [l, p] = [toRad(lon), toRad(lat)];
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(p) ** 2);
  return [(n + height) * Math.cos(p) * Math.cos(l), (n + height) * Math.cos(p) * Math.sin(l), (n * (1 - WGS84_E2) + height) * Math.sin(p)];
}

function fromEcef([x, y, z]: Vec3): { lon: number; lat: number } {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 5; i++) {
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
    const h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + h)));
  }
  return { lon: toDeg(Math.atan2(y, x)), lat: toDeg(lat) };
}

/**
 * カメラの視線と、楕円体を `ground` (m) だけ膨らませた面との交点。空を見ていれば undefined。
 * 向き (`heading` は北から時計回り、`pitch` は水平が 0 で下向きが負。どちらも度) はカメラの位置の東・北・上で組む。
 */
function rayToGround(camera: { lon: number; lat: number; height: number }, heading: number, pitch: number, ground: number) {
  const [l, p, h, t] = [toRad(camera.lon), toRad(camera.lat), toRad(heading), toRad(pitch)];
  const east: Vec3 = [-Math.sin(l), Math.cos(l), 0];
  const north: Vec3 = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up: Vec3 = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const d = [0, 1, 2].map((i) => Math.cos(t) * (Math.sin(h) * east[i] + Math.cos(h) * north[i]) + Math.sin(t) * up[i]) as Vec3;
  const o = toEcef(camera.lon, camera.lat, camera.height);
  // 膨らませた楕円体を単位球に縮めて解く。
  const radii: Vec3 = [WGS84_A + ground, WGS84_A + ground, WGS84_B + ground];
  const os = o.map((v, i) => v / radii[i]);
  const ds = d.map((v, i) => v / radii[i]);
  const a = ds.reduce((s, v) => s + v * v, 0);
  const b = 2 * os.reduce((s, v, i) => s + v * ds[i], 0);
  const c = os.reduce((s, v) => s + v * v, 0) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return undefined;
  const distance = (-b - Math.sqrt(disc)) / (2 * a);
  if (distance <= 0) return undefined;
  return { ...fromEcef(o.map((v, i) => v + distance * d[i]) as Vec3), distance };
}

/** 作るのに WASM と Worker を起こすので、非同期。 */
export async function createNavaraEngine(options: NavaraEngineOptions): Promise<NavaraEngine> {
  const { container, quantizedMeshTerrains, onMoveEnd } = options;
  // 作るときに入れ物の大きさを読むので、見えている状態で作る。
  container.hidden = false;
  // **画面 (canvas) は自分で作って渡す。** 渡さないと Navara が画面いっぱい (100vw × 100vh) の入れ物を body の末尾に足し、
  // 中の canvas を container へ移したあとも空の入れ物が残って、ページが縦に2倍に伸びた (ホイールでページがスクロールした)。
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  const navara = new ThreeView<DefaultDescriptions>({ container, canvas });
  navara.addPlugin(new DefaultPlugin()); // init の前に
  await navara.init();
  navara.addLight({ ambient: { intensity: 1.5 } });
  navara.addLight({ sun: {} });

  // **縦の画角を明示する。** 作った直後は読めず (undefined)、仮の値で置くとズームが 0.17 ずれた (既定は 50°)。
  navara.camera.fov = FOV_DEG;
  const fovy = () => toRad(navara.camera.fov ?? FOV_DEG);
  const height = () => container.clientHeight || 720;

  /**
   * 画面の真ん中の地面と、カメラからの距離。**カメラの位置と向きから、視線と地面の高さの面との交点を計算する。**
   * 描いた地表を拾う (`pickTerrainPosition`) と、読み込みの途中の粗いタイル (楕円体より低い弦) に当たって
   * 視線の先へずれた (傾けた表示で約500m。Cesium でも同じことが起きた)。地面の高さは読み込んだ地形から取る (無ければ 0)。
   */
  const lookingAt = () => {
    const position = navara.camera.positionGeographic;
    const { heading = 0, pitch = -90 } = navara.camera.orientation;
    const camera = { lon: position.lng, lat: position.lat, height: position.height };
    const first = rayToGround(camera, heading, pitch, 0);
    if (!first) return undefined;
    const ground = navara.sampleTerrainHeight({ lat: first.lat, lng: first.lon });
    return ground ? (rayToGround(camera, heading, pitch, ground) ?? first) : first;
  };

  let lastView: View = { lon: 139.767, lat: 35.681, zoom: 15, pitch: 50, bearing: 0 };
  const view = (): View => {
    const here = lookingAt();
    if (!here) return lastView;
    const { heading = 0, pitch = -90 } = navara.camera.orientation;
    return {
      lon: here.lon,
      lat: here.lat,
      zoom: zoomForRange(here.distance, here.lat, height(), fovy()),
      pitch: Math.max(0, Math.min(85, pitch + 90)),
      // MapLibre の向きは -180〜180°。
      bearing: ((heading + 540) % 360) - 180,
    };
  };

  /** 注視点を MapLibre と同じにする。`ground` は注視点の楕円体高。 */
  const placeCamera = (target: View, ground: number) => {
    navara.setCamera({
      lng: target.lon,
      lat: target.lat,
      height: ground,
      heading: target.bearing,
      pitch: target.pitch - 90,
      roll: 0,
      distance: rangeForZoom(target.zoom, target.lat, height(), fovy()),
    });
  };

  // ---- 出典 (出している間だけ) ----
  const setCredits = (collections: Collection[]) => {
    navara.attribution?.clear();
    navara.attribution?.add(collections.map((c) => ({ attributionHtml: c.attribution })));
  };

  // ---- 地形と背景地図 ----
  // **重ね順は足した順** で、地形を先に足す。並びや地形が変わったら、地形から足し直す (ソースは使い回す)。
  const sources = new Map<string, Source>();
  const sourceOf = (key: string, make: () => Source) => {
    let source = sources.get(key);
    if (!source) {
      source = make();
      sources.set(key, source);
    }
    return source;
  };
  let terrain: { id: string | undefined; layer: Layer; source: Source | undefined } | undefined;
  const rasters = new Map<string, Layer>();
  let rasterOrder = '';
  const terrainFor = (choice: NavaraTerrainChoice): Collection | undefined => {
    if (!choice.enabled) return undefined;
    if (choice.selected?.quantizedMesh) return choice.selected;
    return quantizedMeshTerrains.find((c) => c.id === 'reearth-terrain') ?? quantizedMeshTerrains[0];
  };
  const syncSurface = (rows: Extract<NavaraRow, { kind: 'raster' }>[], terrainCollection: Collection | undefined) => {
    const order = rows.map((r) => r.collection.id).join(',');
    if (terrain && terrain.id === terrainCollection?.id && order === rasterOrder) {
      for (const row of rows) {
        rasters.get(row.collection.id)!.update({
          type: 'raster',
          source: sources.get(row.collection.id)!,
          raster: { opacity: row.opacity },
        });
      }
      return;
    }
    for (const layer of rasters.values()) layer.delete();
    rasters.clear();
    terrain?.layer.delete();
    if (terrainCollection) {
      // layer.json の隣にタイルがある (`{z}/{x}/{y}.terrain`)。水面 (watermask) は頼まない (Cesium と同じ。出典に載せていないため)。
      const source = sourceOf(`terrain:${terrainCollection.id}`, () =>
        navara.addSource({
          type: 'quantized-mesh',
          url: terrainCollection.quantizedMesh!.replace(/layer\.json$/, '{z}/{x}/{y}.terrain'),
          requestVertexNormals: true,
        }),
      );
      terrain = { id: terrainCollection.id, layer: navara.addLayer({ type: 'terrain', source }), source };
    } else {
      terrain = { id: undefined, layer: navara.addLayer({ type: 'terrain', ellipsoid: {} }), source: undefined };
    }
    // **下の行から足す** (後に足したものが上 = 一覧の先頭)。
    for (const row of [...rows].reverse()) {
      const { collection } = row;
      const source = sourceOf(collection.id, () =>
        navara.addSource({ type: 'raster-tile', url: collection.tileLink!.href, maxZoom: collection.zoom?.[1] ?? 18 }),
      );
      rasters.set(collection.id, navara.addLayer({ type: 'raster', source, raster: { opacity: row.opacity } }));
    }
    rasterOrder = order;
  };

  // ---- 3D Tiles (出しているものだけ層を置く。ソースは使い回す) ----
  const tilesets = new Map<string, Layer>();
  const syncTilesets = (rows: Extract<NavaraRow, { kind: '3d_tiles' }>[]) => {
    const wanted = new Set(rows.map((r) => r.collection.id));
    for (const [id, layer] of tilesets) {
      if (wanted.has(id)) continue;
      layer.delete();
      tilesets.delete(id);
    }
    for (const { collection } of rows) {
      if (tilesets.has(collection.id)) continue;
      const source = sourceOf(collection.id, () => navara.addSource({ type: '3d-tiles', url: collection.tileLink!.href }));
      tilesets.set(collection.id, navara.addLayer({ type: '3d-tiles', source }));
    }
  };

  const sync = (rows: NavaraRow[], choice: NavaraTerrainChoice) => {
    const terrainCollection = terrainFor(choice);
    syncSurface(rows.filter((r): r is Extract<NavaraRow, { kind: 'raster' }> => r.kind === 'raster'), terrainCollection);
    syncTilesets(rows.filter((r): r is Extract<NavaraRow, { kind: '3d_tiles' }> => r.kind === '3d_tiles'));
    setCredits([...rows.map((r) => r.collection), ...(terrainCollection ? [terrainCollection] : [])]);
    navara.forceUpdate();
    return terrainCollection;
  };

  let shown = true;
  navara.camera.on('moveend', () => {
    if (!shown) return;
    lastView = view();
    onMoveEnd(lastView);
  });

  return {
    navara,
    view,
    sync,
    show: async (target) => {
      container.hidden = false;
      shown = true;
      navara.resize();
      lastView = target;
      placeCamera(target, 0);
      // 注視点の地面の高さ (0 に置くと、山で寄ったときカメラが地面の下に入る)。
      if (terrain?.source) {
        try {
          const [point] = await navara.sampleTerrainMostDetailed(terrain.source, [{ lat: target.lat, lng: target.lon }]);
          if (shown && Number.isFinite(point?.height)) placeCamera(target, point.height!);
        } catch (e) {
          console.warn('[navara] terrain height not sampled', e);
        }
      }
    },
    hide: () => {
      shown = false;
      container.hidden = true;
    },
  };
}
