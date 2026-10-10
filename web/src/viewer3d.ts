/**
 * **3D で見るページ (Cesium)。** いまの地図 (MapLibre) から同じ場所を開く。
 *
 * まずは「同じ場所を別のエンジンで開く」— 位置と、背景地図・3D Tiles だけを渡す (docs/roadmap.md)。
 * 建物・鉄道などのデータの描き方は MapLibre の層なので、ここには持ち込まない。
 *
 * - **Cesium ion は使わない** (登録が要る)。背景地図と 3D Tiles はこのカタログ (`collections.json`) から組む
 * - 地形はまだ平らな楕円体 (次の段で、カタログの標高を渡す)
 * - Cesium を選んだ理由の1つは **3D Tiles 2.0** を試すこと (利用者のねらい)
 */
import {
  buildModuleUrl,
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Credit,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  ImageryLayer,
  Math as CesiumMath,
  Matrix4,
  PerspectiveFrustum,
  Rectangle,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { fetchCollections, type Collection } from './lib/stac';
import { applyHtmlText, lang, m } from './i18n';
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
  const status = document.querySelector<HTMLParagraphElement>('#viewer3d-status')!;
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
  // 地面より下の 3D Tiles も見えるように (地形が平らな楕円体なので、建物は少し浮く・沈むことがある)。
  viewer.scene.globe.depthTestAgainstTerrain = false;

  // 注視点を MapLibre と同じにする (lookAt で置いてから、操作できるよう固定を外す)。
  const target = Cartesian3.fromDegrees(view.lon, view.lat, 0);
  // Cesium の画角 (既定 60°) は**縦と横の長い方**に掛かるので、縦の画角を frustum から取る。
  const fovy = () => (viewer.camera.frustum as PerspectiveFrustum).fovy ?? CesiumMath.toRadians(60);
  const range = rangeForZoom(view.zoom, view.lat, viewer.canvas.clientHeight || 720, fovy());
  viewer.camera.lookAt(
    target,
    new HeadingPitchRange(CesiumMath.toRadians(view.bearing), CesiumMath.toRadians(view.pitch - 90), range),
  );
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);

  let collections: Collection[];
  try {
    collections = await fetchCollections(lang);
  } catch (e) {
    status.textContent = m.initFailed;
    throw e;
  }

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
        status.textContent = m.loadFailed(collection.title);
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

  // ---- 地図に戻る (いま見ている場所を渡す) ----
  document.querySelector<HTMLAnchorElement>('#back-to-map')!.addEventListener('click', (event) => {
    event.preventDefault();
    const canvas = viewer.canvas;
    const center = viewer.camera.pickEllipsoid(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    const camera = viewer.camera;
    let lon = view.lon;
    let lat = view.lat;
    let distance = range;
    if (center) {
      const c = viewer.scene.globe.ellipsoid.cartesianToCartographic(center);
      lon = CesiumMath.toDegrees(c.longitude);
      lat = CesiumMath.toDegrees(c.latitude);
      distance = Cartesian3.distance(camera.positionWC, center);
    }
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
