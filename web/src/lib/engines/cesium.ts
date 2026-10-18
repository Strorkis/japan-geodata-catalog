/**
 * **Cesium のエンジン。** 地図 (MapLibre) と同じページで、バーから切り替えて使う (docs/roadmap.md「行き先」)。
 *
 * - **一覧の状態から描く** (`sync`)。どの行を出すか・重ね順・不透明度は一覧が持ち、ここはそれを写すだけ。
 *   描けるのは MapLibre に依らない行 = 背景地図 (XYZ)・3D Tiles・ベクトルタイル・地形。データの行 (DuckDB) はまだ描かない (TOBE)
 * - **見え方の正本は MapLibre。** カメラが止まるたびに `onMoveEnd` で知らせ、呼ぶ側が (隠れている) MapLibre を合わせる
 * - **一度作ったら壊さない。** 隠すときは描くのを止めるだけ (毎回作り直すと DOM が少しずつ残った。2026-10-12 に測った)
 * - **Cesium ion は使わない** (登録が要る)。背景地図と 3D Tiles はカタログから。いちばん下には同梱の Natural Earth II
 * - **地形は楕円体高の quantized-mesh** (Re:Earth Terrain)。3D Tiles (PLATEAU・Re:Earth Buildings) も楕円体高なので、
 *   ジオイドの補正を書かずに建物が地面に乗る。地理院・AW3D30 は海面からの高さで、そのまま渡すと東京で約37mずれる
 * - Cesium を選んだ理由の1つは **3D Tiles 2.0** を試すこと (利用者のねらい)。1.146 で動くのはその部品 (ベクタ) まで
 */
import {
  buildModuleUrl,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  Cesium3DTileStyle,
  CesiumTerrainProvider,
  Credit,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  HeightReference,
  ImageryLayer,
  Math as CesiumMath,
  Matrix4,
  MVTDataProvider,
  PerspectiveFrustum,
  Rectangle,
  sampleTerrainMostDetailed,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type TerrainProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Collection, VectorLayerInfo } from '@japan-geodata-catalog/core/stac';
import { rangeForZoom, zoomForRange } from '@japan-geodata-catalog/core/zoom';
import { pmtilesTemplate } from '../cesium-pmtiles';
import type { View } from '../view-params';

// Cesium の資産 (Workers・Assets・Widgets) の置き場所。ビルドでは `cesium/` に写す (vite.config.ts)。
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

/** `scene.pick` で拾った地物のうち、吹き出しに使うところ。 */
interface PickedTileFeature {
  tileset: unknown;
  getPropertyIds: () => string[];
  getProperty: (name: string) => unknown;
}

/**
 * 拾ったものが 3D Tiles の地物なら、その形で返す。**型 (クラス) では判定しない** — 地面に貼り付けたベクタを拾うと
 * `Cesium3DTileVectorFeature` が返るが、これは公開の型に無い (`Cesium3DTileFeature` で判定していたら、拾えていても
 * 全部捨てていて、吹き出しが出なかった)。持っているもので判定する。
 */
function asTileFeature(picked: unknown): PickedTileFeature | undefined {
  if (typeof picked !== 'object' || picked === null) return undefined;
  const candidate = picked as Partial<PickedTileFeature>;
  return candidate.tileset !== undefined &&
    typeof candidate.getPropertyIds === 'function' &&
    typeof candidate.getProperty === 'function'
    ? (candidate as PickedTileFeature)
    : undefined;
}

/**
 * **地面に貼り付けたベクタを拾えるようにする** (Cesium 1.146 の抜けの穴埋め。Cesium の版を上げたら要るか確かめる)。
 *
 * 貼り付けたベクタは地表に焼き込まれ、拾うときは地表を通して「拾うための色」を読む。その色は各線の pick ID から作るが、
 * ID を作る `_updatePickIds` は集まりの `update` の中でしか呼ばれない。MVT の中身 (`VectorGltf3DTileContent.update`) は
 * 貼り付けるときに集まりの `update` を呼ばず焼き込みに回すだけなので、ID が作られず、**何も拾えなかった**
 * (2026-10-12。上流の main でも同じ)。集まりの `update` を代わりに呼ぶと、集まり自身は貼り付けの印を持たないので
 * 宙にもう一度描かれてしまう。そこで ID を作るところだけを、中身の `update` の前後で呼ぶ。
 * 中身のクラスは公開されていないので、読み込んだ最初の中身の原型 (prototype) に一度だけ手を入れる。
 * TOBE: 上流で直れば外す (投稿はしない)。
 */
type PickableCollection = { _updatePickIds?: (context: unknown) => void };
let drapedPickingEnabled = false;
function enableDrapedVectorPicking(content: unknown) {
  if (drapedPickingEnabled || typeof content !== 'object' || content === null || !('_collections' in content)) return;
  const proto = Object.getPrototypeOf(content) as {
    update?: (this: { _collections?: PickableCollection[] }, tileset: unknown, frameState: { context: unknown }) => void;
  };
  const original = proto.update;
  if (typeof original !== 'function') return;
  drapedPickingEnabled = true;
  proto.update = function (tileset, frameState) {
    // 前: 前のコマまでにできた集まり。後: このコマで初めてできた集まり (焼き込みより前に間に合わせる)。
    for (const collection of this._collections ?? []) collection._updatePickIds?.(frameState.context);
    original.call(this, tileset, frameState);
    for (const collection of this._collections ?? []) collection._updatePickIds?.(frameState.context);
  };
}

/** 吹き出しのために拾う広さ (画素)。 */
const PICK_SIZE = 7;

/** ベクトルタイルを読む広さ (度。片側)。z14 のタイル (約0.022°) で 3×3 ほど。 */
const VECTOR_HALF_SPAN_DEG = 0.03;

/** 一覧の行のうち、Cesium で描くもの。**上の行ほど上** (一覧の並び) で渡す。 */
export type CesiumRow =
  | { kind: 'raster'; collection: Collection; opacity: number }
  /** `url` は読む tileset.json (PLATEAU なら一覧で選んだ LOD・テクスチャの組み合わせ。lib/plateau-tiles.ts)。 */
  | { kind: '3d_tiles'; collection: Collection; url: string }
  /** ベクトルタイル。出している層 (テーマをまたいで Collection ごとにまとめる) と、層ごとの色。 */
  | { kind: 'vector'; collection: Collection; layers: { layer: VectorLayerInfo; color: string }[] };

export interface CesiumTerrainChoice {
  enabled: boolean;
  /** 地形の欄で選んでいる標高。quantized-mesh を持たなければ、持つもの (Re:Earth Terrain) に替える。 */
  selected: Collection | undefined;
}

export interface CesiumEngine {
  /** 出す。MapLibre の見え方からカメラを置く。 */
  show: (view: View) => Promise<void>;
  /** 隠す (壊さず、描くのを止める)。 */
  hide: () => void;
  /** いまの見え方 (MapLibre の形に直したもの)。 */
  view: () => View;
  /** 一覧の状態を写す。**使う地形** (選んだ標高の代わりに替えたものを含む。平らなら undefined) を返す。 */
  sync: (rows: CesiumRow[], terrain: CesiumTerrainChoice) => Collection | undefined;
  /** E2E のための足がかり。 */
  viewer: Viewer;
}

export interface CesiumEngineOptions {
  /** 入れ物 (地図と同じ場所に重ねる)。 */
  container: HTMLElement;
  /** 地形に使える quantized-mesh を持つ Collection (カタログの `rel: quantized-mesh`)。 */
  quantizedMeshTerrains: Collection[];
  /** カメラが止まったとき (MapLibre を合わせるため)。 */
  onMoveEnd: (view: View) => void;
  /** 読めなかったもの。 */
  onFailure: (collection: Collection) => void;
  /**
   * ベクトルタイルの地物の上にいるとき (外れたら undefined)。吹き出しを出すため。
   * `x`・`y` は入れ物の中の画素。指で押したときも同じものを知らせる (スマホにはホバーが無い)。
   */
  onHover: (hit: CesiumVectorHit | undefined) => void;
}

/** ベクトルタイルの地物1つ (吹き出しの元)。 */
export interface CesiumVectorHit {
  collection: Collection;
  /** タイルの中の層の名前 (`RdCL` など)。 */
  sourceLayer: string;
  props: Record<string, unknown>;
  x: number;
  y: number;
}

export function createCesiumEngine(options: CesiumEngineOptions): CesiumEngine {
  const { container, quantizedMeshTerrains, onMoveEnd, onFailure, onHover } = options;
  const viewer = new Viewer(container, {
    // **ion を使う部品は出さない** (背景地図の選択・地名検索は ion の Bing などを読む)。
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    homeButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // **変化があったときだけ描く。** 既定は止まっていても毎コマ描き続け、CPU と電池を食う
    // (GPU の無いテストでは、Cesium のテストが2つ重なると全体が 19.6分 → 29分 に延び、ほかのテストまで時間切れになった)。
    // カメラ・タイルの読み込みは Cesium が自分で描き直しを頼む。一覧から変えたときは `requestRender` を呼ぶ。
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });
  // **いちばん下に世界の地図を敷く** (Cesium に同梱の Natural Earth II。パブリックドメインで、外へ読みに行かない)。
  viewer.imageryLayers.add(
    ImageryLayer.fromProviderAsync(TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'))),
  );
  // Cesium の画角 (既定 60°) は**縦と横の長い方**に掛かるので、縦の画角を frustum から取る。
  const fovy = () => (viewer.camera.frustum as PerspectiveFrustum).fovy ?? CesiumMath.toRadians(60);
  const height = () => viewer.canvas.clientHeight || 720;

  /**
   * 画面の真ん中の地面 (地形があれば地形との交点、無ければ楕円体との交点)。空なら undefined。
   * **平らなときは楕円体と直接交わらせる。** 地表のメッシュ (`globe.pick`) は読み込みの途中だと粗い弦で、
   * 楕円体より低い。傾けて見ていると交点が視線の先へずれ、切り替えた直後に戻ると約300mずれた。
   */
  const lookingAt = () => {
    const middle = new Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2);
    const ray = viewer.camera.getPickRay(middle);
    const onTerrain = viewer.terrainProvider instanceof CesiumTerrainProvider;
    const center =
      (onTerrain && ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ?? viewer.camera.pickEllipsoid(middle);
    if (!center) return undefined;
    const c = viewer.scene.globe.ellipsoid.cartesianToCartographic(center);
    return {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      distance: Cartesian3.distance(viewer.camera.positionWC, center),
    };
  };

  let lastView: View = { lon: 139.767, lat: 35.681, zoom: 15, pitch: 50, bearing: 0 };
  const view = (): View => {
    const here = lookingAt();
    if (!here) return lastView;
    return {
      lon: here.lon,
      lat: here.lat,
      zoom: zoomForRange(here.distance, here.lat, height(), fovy()),
      pitch: Math.max(0, Math.min(85, CesiumMath.toDegrees(viewer.camera.pitch) + 90)),
      // Cesium の向きは 0〜360°、MapLibre は -180〜180°。
      bearing: ((CesiumMath.toDegrees(viewer.camera.heading) + 540) % 360) - 180,
    };
  };

  /** 注視点を MapLibre と同じにする (lookAt で置いてから、操作できるよう固定を外す)。`ground` は注視点の楕円体高。 */
  const placeCamera = (target: View, ground: number) => {
    viewer.camera.lookAt(
      Cartesian3.fromDegrees(target.lon, target.lat, ground),
      new HeadingPitchRange(
        CesiumMath.toRadians(target.bearing),
        CesiumMath.toRadians(target.pitch - 90),
        rangeForZoom(target.zoom, target.lat, height(), fovy()),
      ),
    );
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  };

  // ---- 出典 (出している間だけ。3D Tiles や地形には出典の指定が無いので、カタログの文言を足す) ----
  const credits = new Map<string, Credit>();
  const shownCredits = new Set<string>();
  const creditOf = (collection: Collection) => {
    let credit = credits.get(collection.id);
    if (!credit) {
      credit = new Credit(collection.attribution, true);
      credits.set(collection.id, credit);
    }
    return credit;
  };
  const setCredits = (collections: Collection[]) => {
    const next = new Set(collections.map((c) => c.id));
    for (const id of shownCredits) {
      if (!next.has(id)) viewer.creditDisplay.removeStaticCredit(credits.get(id)!);
    }
    for (const collection of collections) {
      if (!shownCredits.has(collection.id)) viewer.creditDisplay.addStaticCredit(creditOf(collection));
    }
    shownCredits.clear();
    for (const id of next) shownCredits.add(id);
  };

  // ---- 地形 ----
  let terrainId: string | undefined; // いま使っている quantized-mesh (undefined = 平ら)
  let terrainLoading: Promise<void> = Promise.resolve();
  const terrainFor = (choice: CesiumTerrainChoice): Collection | undefined => {
    if (!choice.enabled) return undefined;
    if (choice.selected?.quantizedMesh) return choice.selected;
    // 選んでいる標高が海面からの高さ (Terrarium) なら、楕円体高のものに替える (建物が浮かないように)。
    return quantizedMeshTerrains.find((c) => c.id === 'reearth-terrain') ?? quantizedMeshTerrains[0];
  };
  const setTerrain = (collection: Collection | undefined) => {
    if (collection?.id === terrainId) return;
    terrainId = collection?.id;
    const target = terrainId;
    terrainLoading = (async () => {
      let provider: TerrainProvider = new EllipsoidTerrainProvider();
      if (collection) {
        try {
          // layer.json を持つディレクトリを渡す (`fromUrl` が layer.json を足して読む)。
          // 水面 (watermask) は頼まない: Protomaps (ODbL) 由来で、カタログの出典に載せていないため。
          provider = await CesiumTerrainProvider.fromUrl(collection.quantizedMesh!.replace(/layer\.json$/, ''), {
            requestVertexNormals: true,
          });
        } catch (e) {
          // 読めなければ平らのまま (状況は呼ぶ側が出す)。
          console.error('[cesium] terrain failed', collection.id, e);
          onFailure(collection);
        }
      }
      if (terrainId !== target) return; // 読む間に替わった
      viewer.terrainProvider = provider;
      viewer.scene.requestRender();
      // 山の向こうの建物が透けないよう、地形があるときは地形で隠す。
      viewer.scene.globe.depthTestAgainstTerrain = provider instanceof CesiumTerrainProvider;
    })();
  };

  // ---- 背景地図 (ラスタタイル) ----
  const imagery = new Map<string, ImageryLayer>();
  const syncImagery = (rows: Extract<CesiumRow, { kind: 'raster' }>[]) => {
    const wanted = new Set(rows.map((r) => r.collection.id));
    for (const [id, layer] of imagery) {
      if (!wanted.has(id)) {
        viewer.imageryLayers.remove(layer);
        imagery.delete(id);
      }
    }
    // **下の行から順に、いちばん上へ上げる** (最後に上げたものがいちばん上 = 一覧の先頭)。
    for (const row of [...rows].reverse()) {
      const { collection } = row;
      let layer = imagery.get(collection.id);
      if (!layer) {
        const [west, south, east, north] = collection.bbox ?? [-180, -85, 180, 85];
        layer = viewer.imageryLayers.addImageryProvider(
          new UrlTemplateImageryProvider({
            url: collection.tileLink!.href,
            minimumLevel: collection.zoom?.[0] ?? 0,
            maximumLevel: collection.zoom?.[1] ?? 18,
            rectangle: Rectangle.fromDegrees(west, south, east, north),
          }),
        );
        imagery.set(collection.id, layer);
      }
      layer.alpha = row.opacity;
      viewer.imageryLayers.raiseToTop(layer);
    }
  };

  // ---- 3D Tiles ----
  // 鍵は「Collection ID と URL」 (LOD・テクスチャを替えると URL が変わり、別のタイルセットになる)。
  const tilesets = new Map<string, Promise<Cesium3DTileset | undefined>>();
  const tilesetKey = (row: Extract<CesiumRow, { kind: '3d_tiles' }>) => `${row.collection.id}|${row.url}`;
  const syncTilesets = (rows: Extract<CesiumRow, { kind: '3d_tiles' }>[]) => {
    const wanted = new Set(rows.map(tilesetKey));
    for (const row of rows) {
      const key = tilesetKey(row);
      if (tilesets.has(key)) continue;
      tilesets.set(
        key,
        Cesium3DTileset.fromUrl(row.url)
          .then((tileset) => viewer.scene.primitives.add(tileset) as Cesium3DTileset)
          .catch((e: unknown) => {
            console.error('[cesium] tileset failed', row.collection.id, e);
            onFailure(row.collection);
            tilesets.delete(key);
            return undefined;
          }),
      );
    }
    // 替えて使わなくなった組み合わせは捨てる (残すとメモリを食う)。
    for (const [key, loading] of tilesets) {
      if (wanted.has(key) || !rows.some((row) => key.startsWith(`${row.collection.id}|`))) continue;
      tilesets.delete(key);
      void loading.then((tileset) => {
        if (tileset) viewer.scene.primitives.remove(tileset);
        viewer.scene.requestRender();
      });
    }
    for (const [key, loading] of tilesets) {
      void loading.then((tileset) => {
        if (!tileset) return;
        tileset.show = wanted.has(key);
        viewer.scene.requestRender();
      });
    }
  };

  // ---- ベクトルタイル (PMTiles を中継して MVTDataProvider へ。3D Tiles 2.0 のベクタの部品) ----
  // `MVTDataProvider` (実験段階) は最初に範囲の中のタイルの木を全部作るので、**見ている場所の周りだけ**を読み、
  // 離れたら作り直す。上流の `MVT_implicit_tile` (未マージ) が入れば、この絞りは要らない。
  const vectors = new Map<string, { provider: MVTDataProvider; key: string; center: [number, number] }>();
  let vectorRows: Extract<CesiumRow, { kind: 'vector' }>[] = [];
  const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const building = new Map<string, Promise<void>>();
  const buildVector = async (row: Extract<CesiumRow, { kind: 'vector' }>, key: string) => {
    const here = lookingAt() ?? { lon: lastView.lon, lat: lastView.lat };
    const layers = row.layers.map((l) => l.layer);
    try {
      const provider = await MVTDataProvider.fromUrl(pmtilesTemplate(row.collection.id, row.collection.assets.data!.href), {
        minZoom: Math.min(...layers.map((l) => l.minzoom)),
        maxZoom: Math.max(...layers.map((l) => l.maxzoom)),
        extent: Rectangle.fromDegrees(
          here.lon - VECTOR_HALF_SPAN_DEG,
          here.lat - VECTOR_HALF_SPAN_DEG,
          here.lon + VECTOR_HALF_SPAN_DEG,
          here.lat + VECTOR_HALF_SPAN_DEG,
        ),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        scene: viewer.scene,
      });
      // 貼り付けたベクタを拾えるようにする (最初に読み込んだ中身で一度だけ)。
      provider.tileset!.tileLoad.addEventListener((tile: { content: unknown }) => enableDrapedVectorPicking(tile.content));
      // 層ごとの色は、地物に付く `_layer` (MVT の層の名前) で分ける。
      provider.tileset!.style = new Cesium3DTileStyle({
        show: layers.map((l) => `\${_layer} === ${quote(l.id)}`).join(' || '),
        color: {
          conditions: [
            ...row.layers.map(({ layer, color }): [string, string] => [
              `\${_layer} === ${quote(layer.id)}`,
              `color(${quote(color)})`,
            ]),
            ['true', "color('#666666')"],
          ],
        },
      });
      // 作る間に一覧が変わっていたら捨てる。
      const current = vectorRows.find((r) => r.collection.id === row.collection.id);
      if (!current || keyOf(current) !== key) {
        // まだ場面に足していないので、中のタイルセットだけ片付ける (型定義に provider の destroy が無い)。
        provider.tileset?.destroy();
        return;
      }
      const old = vectors.get(row.collection.id);
      if (old) viewer.scene.primitives.remove(old.provider);
      viewer.scene.primitives.add(provider);
      viewer.scene.requestRender();
      vectors.set(row.collection.id, { provider, key, center: [here.lon, here.lat] });
    } catch (e) {
      console.error('[cesium] vector tiles failed', row.collection.id, e);
      onFailure(row.collection);
    }
  };
  const keyOf = (row: Extract<CesiumRow, { kind: 'vector' }>) => row.layers.map((l) => `${l.layer.id}:${l.color}`).join(',');
  const syncVectors = (rows: Extract<CesiumRow, { kind: 'vector' }>[], force = false) => {
    vectorRows = rows;
    const wanted = new Set(rows.map((r) => r.collection.id));
    for (const [id, entry] of vectors) {
      if (!wanted.has(id)) {
        viewer.scene.primitives.remove(entry.provider);
        vectors.delete(id);
      }
    }
    const here = lookingAt();
    for (const row of rows) {
      const key = keyOf(row);
      const entry = vectors.get(row.collection.id);
      // 半分より外へ出たら、その場所の周りで作り直す。
      const moved =
        here &&
        entry &&
        (Math.abs(here.lon - entry.center[0]) > VECTOR_HALF_SPAN_DEG / 2 ||
          Math.abs(here.lat - entry.center[1]) > VECTOR_HALF_SPAN_DEG / 2);
      if (entry && entry.key === key && !moved && !force) continue;
      const pending = `${row.collection.id}|${key}`;
      if (building.has(pending)) continue;
      const job = buildVector(row, key).finally(() => building.delete(pending));
      building.set(pending, job);
    }
  };

  let lastRows: CesiumRow[] = [];
  const sync = (rows: CesiumRow[], terrain: CesiumTerrainChoice) => {
    lastRows = rows;
    syncImagery(rows.filter((r): r is Extract<CesiumRow, { kind: 'raster' }> => r.kind === 'raster'));
    syncTilesets(rows.filter((r): r is Extract<CesiumRow, { kind: '3d_tiles' }> => r.kind === '3d_tiles'));
    syncVectors(rows.filter((r): r is Extract<CesiumRow, { kind: 'vector' }> => r.kind === 'vector'));
    const terrainCollection = terrainFor(terrain);
    setTerrain(terrainCollection);
    setCredits([...rows.map((r) => r.collection), ...(terrainCollection ? [terrainCollection] : [])]);
    viewer.scene.requestRender();
    return terrainCollection;
  };

  // ---- 吹き出し (ベクトルタイルの地物) ----
  // **1コマに1回だけ拾う** (`scene.pick` は拾うための描画をもう1回するので、マウスが動くたびに呼ぶと重い)。
  // 地物には `_layer` (MVT の層の名前) と元の属性 (`vt_code`・`vt_text`) が付いている。
  // 3D Tiles (PLATEAU) の建物は属性の形が違うので、まだ出さない (TOBE)。
  const pickVector = (position: Cartesian2): CesiumVectorHit | undefined => {
    // 線は1画素ほどの細さなので、マウスの周りを少し広く (7×7画素) 拾う。
    const picked = asTileFeature(viewer.scene.pick(position, PICK_SIZE, PICK_SIZE));
    if (!picked) return undefined;
    for (const row of vectorRows) {
      if (vectors.get(row.collection.id)?.provider.tileset !== picked.tileset) continue;
      const props: Record<string, unknown> = {};
      for (const id of picked.getPropertyIds()) props[id] = picked.getProperty(id);
      const sourceLayer = props._layer;
      if (typeof sourceLayer !== 'string') return undefined;
      return { collection: row.collection, sourceLayer, props, x: position.x, y: position.y };
    }
    return undefined;
  };
  let hoverAt: Cartesian2 | undefined;
  let hoverScheduled = false;
  const hoverNow = () => {
    hoverScheduled = false;
    if (!hoverAt || !viewer.useDefaultRenderLoop) return;
    const hit = pickVector(hoverAt);
    viewer.canvas.style.cursor = hit ? 'pointer' : '';
    onHover(hit);
  };
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: ScreenSpaceEventHandler.MotionEvent) => {
    hoverAt = Cartesian2.clone(movement.endPosition);
    if (hoverScheduled) return;
    hoverScheduled = true;
    requestAnimationFrame(hoverNow);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  // 指で押したとき (スマホ) も同じものを出す。
  handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
    hoverAt = Cartesian2.clone(click.position);
    hoverNow();
  }, ScreenSpaceEventType.LEFT_CLICK);
  viewer.canvas.addEventListener('pointerleave', () => {
    hoverAt = undefined;
    onHover(undefined);
  });

  viewer.camera.moveEnd.addEventListener(() => {
    if (!viewer.useDefaultRenderLoop) return;
    lastView = view();
    onMoveEnd(lastView);
    // 離れたらベクトルタイルを読み直す。
    syncVectors(lastRows.filter((r): r is Extract<CesiumRow, { kind: 'vector' }> => r.kind === 'vector'));
  });

  return {
    viewer,
    view,
    sync,
    show: async (target) => {
      container.hidden = false;
      viewer.useDefaultRenderLoop = true;
      viewer.resize();
      lastView = target;
      placeCamera(target, 0);
      // 注視点の地面の高さ (富士山のふもとと山頂では数千 m 違う)。0 に置くと、寄ったときカメラが地面の下に入る。
      await terrainLoading;
      if (viewer.terrainProvider instanceof CesiumTerrainProvider) {
        try {
          const [point] = await sampleTerrainMostDetailed(viewer.terrainProvider, [
            Cartographic.fromDegrees(target.lon, target.lat),
          ]);
          if (Number.isFinite(point?.height)) placeCamera(target, point.height);
        } catch (e) {
          console.warn('[cesium] terrain height not sampled', e);
        }
      }
    },
    hide: () => {
      hoverAt = undefined;
      onHover(undefined);
      viewer.useDefaultRenderLoop = false;
      container.hidden = true;
    },
  };
}
