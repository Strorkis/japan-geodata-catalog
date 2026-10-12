/**
 * **3D で見るページ (Cesium)。** いまの地図 (MapLibre) から同じ場所を開く。
 *
 * まずは「同じ場所を別のエンジンで開く」— 位置と、背景地図・3D Tiles だけを渡す (docs/roadmap.md)。
 * 建物・鉄道などのデータの描き方は MapLibre の層なので、ここには持ち込まない。
 *
 * - **Cesium ion は使わない** (登録が要る)。背景地図と 3D Tiles はこのカタログ (`collections.json`) から組む
 * - **地形は Re:Earth Terrain** (楕円体高の quantized-mesh)。3D Tiles (PLATEAU・Re:Earth Buildings) も楕円体高なので、
 *   ジオイドの補正を書かずに建物が地面に乗る。地理院・AW3D30 は海面からの高さで、そのまま渡すと東京で約37mずれる
 * - Cesium を選んだ理由の1つは **3D Tiles 2.0** を試すこと (利用者のねらい)
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
  type TerrainProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { fetchCollections, type Collection } from './lib/stac';
import { applyHtmlText, lang, m } from './i18n';
import { pmtilesTemplate } from './lib/cesium-pmtiles';
import { vectorThemeLook } from './lib/vector-looks';
import { readView, viewParams } from './lib/view-params';

// Cesium の資産 (Workers・Assets・Widgets) の置き場所。ビルドでは `cesium/` に写す (vite.config.ts)。
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

/** 赤道の1周 (m)。MapLibre のズームの元。 */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/**
 * MapLibre のズームを、注視点からカメラまでの距離 (m) にする。MapLibre の画面の縦の広さ (画素 × 1画素の m)
 * が、Cesium の縦の画角 `fovy` に収まる距離。傾けても注視点からの距離は変わらない (MapLibre と同じ)。
 */
function rangeForZoom(zoom: number, lat: number, viewportHeight: number, fovy: number): number {
  const metersPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos(CesiumMath.toRadians(lat))) / (512 * 2 ** zoom);
  return ((viewportHeight / 2) * metersPerPixel) / Math.tan(fovy / 2);
}

/** `rangeForZoom` の逆。 */
const zoomForRange = (range: number, lat: number, viewportHeight: number, fovy: number) =>
  Math.log2(
    (EARTH_CIRCUMFERENCE_M * Math.cos(CesiumMath.toRadians(lat)) * (viewportHeight / 2)) /
      (512 * range * Math.tan(fovy / 2)),
  );

async function main() {
  applyHtmlText();
  const statusElement = document.querySelector<HTMLParagraphElement>('#viewer3d-status')!;
  // 読めなかったものを**全部**出す (地形と 3D Tiles が別々に落ちても、最後の1件で上書きしない)。
  const failures = new Map<string, string>();
  const status = {
    fail: (id: string, text: string) => {
      failures.set(id, text);
      statusElement.innerText = [...failures.values()].join('\n');
    },
    clear: (id: string) => {
      failures.delete(id);
      statusElement.innerText = [...failures.values()].join('\n');
    },
  };
  // 位置が無ければ東京駅を斜めから (建物が立って見える)。
  const view = readView(location.search, { zoom: 15, pitch: 50, bearing: 0 }) ?? {
    lon: 139.767,
    lat: 35.681,
    zoom: 15,
    pitch: 50,
    bearing: 0,
  };

  const viewer = new Viewer('viewer', {
    // **ion を使う部品は出さない** (背景地図の選択・地名検索は ion の Bing などを読む)。
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    // 地形は下で選んだものに替える (読み込みを待つので、最初は平ら)。
    terrainProvider: new EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    homeButton: false,
    fullscreenButton: false,
  });
  // **いちばん下に世界の地図を敷く** (Cesium に同梱の Natural Earth II。パブリックドメインで、外へ読みに行かない)。
  // カタログの背景地図は地理院のもの (日本だけ) で、世界の OpenFreeMap はベクタのスタイルなので Cesium では描けない。
  viewer.imageryLayers.add(
    ImageryLayer.fromProviderAsync(TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'))),
  );
  // Cesium の画角 (既定 60°) は**縦と横の長い方**に掛かるので、縦の画角を frustum から取る。
  const fovy = () => (viewer.camera.frustum as PerspectiveFrustum).fovy ?? CesiumMath.toRadians(60);
  const range = rangeForZoom(view.zoom, view.lat, viewer.canvas.clientHeight || 720, fovy());

  /** 注視点を MapLibre と同じにする (lookAt で置いてから、操作できるよう固定を外す)。`height` は注視点の楕円体高。 */
  const placeCamera = (height: number) => {
    viewer.camera.lookAt(
      Cartesian3.fromDegrees(view.lon, view.lat, height),
      new HeadingPitchRange(CesiumMath.toRadians(view.bearing), CesiumMath.toRadians(view.pitch - 90), range),
    );
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  };
  placeCamera(0);

  let collections: Collection[];
  try {
    collections = await fetchCollections(lang);
  } catch (e) {
    status.fail('catalog', m.initFailed);
    throw e;
  }

  // ---- 地形 (カタログの quantized-mesh) ----
  const terrainSelect = document.querySelector<HTMLSelectElement>('#terrain-select')!;
  const terrains = collections.filter((c) => c.quantizedMesh);
  const flat = document.createElement('option');
  flat.value = 'flat';
  flat.textContent = m.flatTerrain;
  terrainSelect.append(flat);
  for (const collection of terrains) {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = collection.title;
    terrainSelect.append(option);
  }
  let terrainCredit: Credit | undefined;
  /** 地形を替える。読めなければ平らに戻して、状況の欄に出す。 */
  const showTerrain = async (id: string): Promise<boolean> => {
    if (terrainCredit) viewer.creditDisplay.removeStaticCredit(terrainCredit);
    terrainCredit = undefined;
    status.clear('terrain');
    const collection = terrains.find((c) => c.id === id);
    let provider: TerrainProvider = new EllipsoidTerrainProvider();
    if (collection) {
      try {
        // layer.json を持つディレクトリを渡す (`fromUrl` が layer.json を足して読む)。
        // 水面 (watermask) は頼まない: Protomaps (ODbL) 由来で、カタログの出典に載せていないため。
        provider = await CesiumTerrainProvider.fromUrl(collection.quantizedMesh!.replace(/layer\.json$/, ''), {
          requestVertexNormals: true,
        });
        terrainCredit = new Credit(collection.attribution, true);
        viewer.creditDisplay.addStaticCredit(terrainCredit);
      } catch (e) {
        console.error('[3d] terrain failed', collection.id, e);
        status.fail('terrain', m.loadFailed(collection.title));
        terrainSelect.value = 'flat';
      }
    }
    viewer.terrainProvider = provider;
    // 山の向こうの建物が透けないよう、地形があるときは地形で隠す。
    viewer.scene.globe.depthTestAgainstTerrain = provider instanceof CesiumTerrainProvider;
    return provider instanceof CesiumTerrainProvider;
  };
  const terrainParam = new URLSearchParams(location.search).get('terrain');
  terrainSelect.value = terrainParam ?? terrains.find((c) => c.id === 'reearth-terrain')?.id ?? terrains[0]?.id ?? 'flat';
  if (![...terrainSelect.options].some((o) => o.value === terrainSelect.value)) terrainSelect.value = 'flat';
  if (await showTerrain(terrainSelect.value)) {
    // 注視点の地面の高さ (富士山のふもとと山頂では数千 m 違う)。0 に置くと、寄ったときカメラが地面の下に入る。
    try {
      const [point] = await sampleTerrainMostDetailed(viewer.terrainProvider, [
        Cartographic.fromDegrees(view.lon, view.lat),
      ]);
      if (Number.isFinite(point?.height)) placeCamera(point.height);
    } catch (e) {
      console.warn('[3d] terrain height not sampled', e);
    }
  }
  terrainSelect.addEventListener('change', () => void showTerrain(terrainSelect.value));

  // ---- 背景地図 (カタログのラスタタイル) ----
  const select = document.querySelector<HTMLSelectElement>('#basemap-select')!;
  const basemaps = collections.filter((c) => c.kind === 'raster_tiles' && c.tileLink?.rel === 'xyz');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = m.none;
  select.append(none);
  // 出所 (サブカタログ) ごとにまとめる。
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const collection of basemaps) {
    const label = collection.group?.title ?? collection.provider ?? '';
    let group = groups.get(label);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = label;
      groups.set(label, group);
      select.append(group);
    }
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = collection.title;
    group.append(option);
  }
  let imagery: ImageryLayer | undefined;
  const showBasemap = (id: string) => {
    if (imagery) viewer.imageryLayers.remove(imagery);
    imagery = undefined;
    const collection = basemaps.find((c) => c.id === id);
    if (!collection) return;
    const [west, south, east, north] = collection.bbox ?? [-180, -85, 180, 85];
    imagery = viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({
        url: collection.tileLink!.href,
        minimumLevel: collection.zoom?.[0] ?? 0,
        maximumLevel: collection.zoom?.[1] ?? 18,
        rectangle: Rectangle.fromDegrees(west, south, east, north),
        credit: new Credit(collection.attribution, true),
      }),
    );
  };
  // 既定はいまの地図と同じ淡色地図。
  const first = basemaps.find((c) => c.id === 'gsi-pale') ?? basemaps[0];
  select.value = new URLSearchParams(location.search).get('basemap') ?? first?.id ?? '';
  showBasemap(select.value);
  select.addEventListener('change', () => showBasemap(select.value));

  // ---- 3D Tiles (カタログの 3D Tiles の Collection) ----
  const options = document.querySelector<HTMLDivElement>('#tileset-options')!;
  const tilesetCollections = collections.filter((c) => c.kind === '3d_tiles' && c.tileLink?.rel === '3d-tiles');
  const loaded = new Map<string, Promise<Cesium3DTileset>>();
  // 3D Tiles には出典の指定が無いので、出している間だけ画面の出典に足す。
  const credits = new Map(tilesetCollections.map((c) => [c.id, new Credit(c.attribution, true)]));
  const setTileset = async (collection: Collection, on: boolean) => {
    const credit = credits.get(collection.id)!;
    if (on) viewer.creditDisplay.addStaticCredit(credit);
    else viewer.creditDisplay.removeStaticCredit(credit);
    if (on && !loaded.has(collection.id)) {
      const promise = Cesium3DTileset.fromUrl(collection.tileLink!.href);
      loaded.set(collection.id, promise);
      try {
        viewer.scene.primitives.add(await promise);
      } catch (e) {
        console.error('[3d] tileset failed', collection.id, e);
        status.fail(collection.id, m.loadFailed(collection.title));
        viewer.creditDisplay.removeStaticCredit(credit);
        loaded.delete(collection.id);
        return;
      }
    }
    const tileset = await loaded.get(collection.id);
    if (tileset) tileset.show = on;
  };
  for (const collection of tilesetCollections) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    // 既定は PLATEAU の公式配信 (日本の建物)。世界の建物 (Re:Earth) は足して見る。
    checkbox.checked = collection.id === 'plateau-3dtiles';
    checkbox.addEventListener('change', () => void setTileset(collection, checkbox.checked));
    label.append(checkbox, document.createTextNode(` ${collection.title}`));
    options.append(label);
    if (checkbox.checked) void setTileset(collection, true);
  }

  /** 画面の真ん中の地面 (地形があれば地形との交点、無ければ楕円体との交点)。見えていなければ最初の場所。 */
  const lookingAt = () => {
    const canvas = viewer.canvas;
    const camera = viewer.camera;
    const middle = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = camera.getPickRay(middle);
    const center = (ray && viewer.scene.globe.pick(ray, viewer.scene)) ?? camera.pickEllipsoid(middle);
    if (!center) return { lon: view.lon, lat: view.lat, distance: range };
    const c = viewer.scene.globe.ellipsoid.cartesianToCartographic(center);
    return {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      distance: Cartesian3.distance(camera.positionWC, center),
    };
  };

  // ---- ベクトルタイル (カタログの PMTiles を、Cesium のベクタ = 3D Tiles 2.0 の部品で描く) ----
  // `MVTDataProvider` (実験段階) は最初に範囲の中のタイルの木を全部作るので、**見ている場所の周りだけ**を読む。
  const vectorPanel = document.querySelector<HTMLDetailsElement>('#vector-panel')!;
  const vectorOptions = document.querySelector<HTMLDivElement>('#vector-options')!;
  const vectorCollections = collections.filter((c) => c.kind === 'vector_tiles' && c.assets.data?.href);
  /** 周りの広さ (度。片側)。z14 のタイル (約0.022°) で 3×3 ほど。 */
  const VECTOR_HALF_SPAN_DEG = 0.03;
  /** Collection ID → 出している層 (テーマの ID ごとにオン/オフ)。 */
  const vectorOn = new Map<string, Set<string>>();
  const vectorProviders = new Map<string, MVTDataProvider>();
  const vectorCredits = new Map(vectorCollections.map((c) => [c.id, new Credit(c.attribution, true)]));
  const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

  /** その Collection を、いま出すと決めた層で作り直す。何も出さないなら外す。 */
  const showVector = async (collection: Collection) => {
    const old = vectorProviders.get(collection.id);
    if (old) {
      viewer.scene.primitives.remove(old);
      vectorProviders.delete(collection.id);
    }
    const credit = vectorCredits.get(collection.id)!;
    status.clear(collection.id);
    const themes = (collection.themes ?? [])
      .map((theme) => ({ theme, layers: theme.layers.filter((l) => vectorOn.get(collection.id)?.has(l.id)) }))
      .filter((entry) => entry.layers.length > 0);
    if (themes.length === 0) {
      viewer.creditDisplay.removeStaticCredit(credit);
      return;
    }
    viewer.creditDisplay.addStaticCredit(credit);
    const layers = themes.flatMap((entry) => entry.layers);
    const here = lookingAt();
    try {
      const provider = await MVTDataProvider.fromUrl(pmtilesTemplate(collection.id, collection.assets.data!.href), {
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
      // 層ごとの色は、地物に付く `_layer` (MVT の層の名前) で分ける。
      provider.tileset!.style = new Cesium3DTileStyle({
        show: layers.map((l) => `\${_layer} === ${quote(l.id)}`).join(' || '),
        color: {
          conditions: [
            ...themes.flatMap(({ theme, layers: own }) =>
              own.map((l): [string, string] => [
                `\${_layer} === ${quote(l.id)}`,
                `color(${quote(vectorThemeLook(theme.id).color)})`,
              ]),
            ),
            ['true', "color('#666666')"],
          ],
        },
      });
      viewer.scene.primitives.add(provider);
      vectorProviders.set(collection.id, provider);
    } catch (e) {
      console.error('[3d] vector tiles failed', collection.id, e);
      status.fail(collection.id, m.loadFailed(collection.title));
      viewer.creditDisplay.removeStaticCredit(credit);
    }
  };

  for (const collection of vectorCollections) {
    // 文字 (点の注記) は 3D では描けないので、点だけのテーマは出さない。
    const themes = (collection.themes ?? []).filter((t) => t.layers.some((l) => l.geometry !== 'Point'));
    if (themes.length === 0) continue;
    vectorPanel.hidden = false;
    const heading = document.createElement('div');
    heading.textContent = collection.title;
    vectorOptions.append(heading);
    for (const theme of themes) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.collection = collection.id;
      checkbox.dataset.theme = theme.id;
      checkbox.addEventListener('change', () => {
        const on = vectorOn.get(collection.id) ?? new Set<string>();
        for (const l of theme.layers.filter((l) => l.geometry !== 'Point')) {
          if (checkbox.checked) on.add(l.id);
          else on.delete(l.id);
        }
        vectorOn.set(collection.id, on);
        void showVector(collection);
      });
      label.append(checkbox, document.createTextNode(` ${theme.title}`));
      vectorOptions.append(label);
    }
  }
  document.querySelector<HTMLButtonElement>('#vector-reload')!.addEventListener('click', () => {
    for (const collection of vectorCollections) if (vectorProviders.has(collection.id)) void showVector(collection);
  });

  // ---- 地図に戻る (いま見ている場所を渡す) ----
  document.querySelector<HTMLAnchorElement>('#back-to-map')!.addEventListener('click', (event) => {
    event.preventDefault();
    const camera = viewer.camera;
    const canvas = viewer.canvas;
    const { lon, lat, distance } = lookingAt();
    const params = viewParams({
      lon,
      lat,
      zoom: zoomForRange(distance, lat, canvas.clientHeight, fovy()),
      pitch: Math.max(0, Math.min(85, CesiumMath.toDegrees(camera.pitch) + 90)),
      // Cesium の向きは 0〜360°、MapLibre は -180〜180°。
      bearing: ((CesiumMath.toDegrees(camera.heading) + 540) % 360) - 180,
    });
    if (lang !== 'ja') params.set('lang', lang);
    location.href = `./?${params}`;
  });

  (window as unknown as { __viewer?: Viewer }).__viewer = viewer;
}

void main();
