/**
 * **MapLibre + Three.js。** MapLibre の地図に Three.js の層 (custom layer) を重ね、**3D Tiles (PLATEAU・Re:Earth Buildings) を描く**。
 * 一覧・周辺検索・吹き出し・建物 (DuckDB の行) は MapLibre のまま (docs/roadmap.md「エンジン」。MapLibre に重ねる側)。
 *
 * - 補助のライブラリ **maplibre-gl-three** (MIT) と 3d-tiles-renderer (Apache-2.0) を使う。地図が動くたびに見ている場所を原点に取り直すので、
 *   全国 (PLATEAU)・全世界 (Re:Earth) のタイルセットでも位置が合う。MapLibre 6.12 以上が要る (2026-10-13 に 6.14 へ上げた)
 * - **高さの基準を自動で合わせる。** 3D Tiles は楕円体高、MapLibre は海面から。ライブラリがジオイド (EGM96) の格子を読んで差を引く。
 *   格子は PROJ の配信 (`cdn.proj.org`、パブリックドメイン) から読む (自前で配るのは TOBE)。読めなければ補正なしで描き、そう言う
 *   (東京で約37m 浮く)
 * - Draco・KTX2 の読み手は自前で配る (`three/`。vite.config.ts)。ライブラリの既定の jsDelivr には読みに行かない
 * - MapLibre の地形とはそのまま重なる (同じ画面に描く custom layer なので、deck.gl のような別画面の問題は無い)
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { ThreeDManager, type ThreeDTilesAsset, type ThreeLayer } from 'maplibre-gl-three';
import {
  AmbientLight,
  DirectionalLight,
  MeshLambertMaterial,
  type Mesh,
  type MeshBasicMaterial,
  type Object3D,
  type Scene,
} from 'three';
import type { Collection } from '@japan-geodata-catalog/core/stac';

const LAYER_ID = 'three-3d-tiles';
const BASE = `${import.meta.env.BASE_URL}three/`;

/**
 * **光を足す。** 補助のライブラリは場面に光を置かない。PLATEAU の glTF は光を受けない材質 (unlit) なので、テクスチャが無いと
 * 屋根も壁も同じ白一色で形が読めなかった (2026-10-14、利用者)。場面の子は地心座標 (ECEF) で置くので、太陽の向きも ECEF で書く。
 * 向きは日本の真ん中 (東経137°・北緯36°) の「上 + 南 + 少し西」(昼過ぎの太陽)。世界の 3D Tiles でも面ごとの明るさの差は出る。
 */
function addLights(scene: Scene) {
  const [lon, lat] = [(137 * Math.PI) / 180, (36 * Math.PI) / 180];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const sunward = [0, 1, 2].map((i) => up[i] - 0.6 * north[i] - 0.3 * east[i]);
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(sunward[0], sunward[1], sunward[2]);
  scene.add(new AmbientLight(0xffffff, 1.2), sun, sun.target);
}

/** **テクスチャの無い面だけ**、光を受ける材質に替える (テクスチャは写真なので、陰影はもう写っている)。面ごとの明るさで形を出す。 */
function shadeUntextured(model: Object3D) {
  // `instanceof` ではなく three.js の印 (`isMesh` など) で見る (読み手と three.js の写しが別でも効くように)。
  model.traverse((object) => {
    const mesh = object as Mesh;
    const plain = mesh.material as MeshBasicMaterial;
    if (!mesh.isMesh || Array.isArray(mesh.material) || !plain.isMeshBasicMaterial || plain.map) return;
    mesh.material = new MeshLambertMaterial({
      color: plain.color,
      // 頂点の法線を持たない形もあるので、面の向きから明るさを出す。
      flatShading: true,
      side: plain.side,
      transparent: plain.transparent,
      opacity: plain.opacity,
    });
    plain.dispose();
  });
}

export interface ThreeEngine {
  /** 地図に重ねる (初回は高さの基準の格子を読む)。 */
  attach: () => Promise<void>;
  /** 地図から外す (読んだタイルは残す)。 */
  detach: () => void;
  /** 描く 3D Tiles を一覧に合わせる。`url` は読む tileset.json (PLATEAU なら選んだ LOD・テクスチャの組み合わせ)。 */
  sync: (tilesets: { collection: Collection; url: string }[]) => void;
  /** 高さの基準 (ジオイド) を合わせられているか。読めなければ false (補正なしで描く)。 */
  datumApplied: () => boolean;
  /** E2E のための足がかり (読み込んで、出している 3D Tiles の Collection ID)。 */
  shown: () => string[];
}

export interface ThreeEngineOptions {
  map: MapLibreMap;
  /** 読めなかったもの。 */
  onFailure: (collection: Collection) => void;
}

export function createThreeEngine({ map, onFailure }: ThreeEngineOptions): ThreeEngine {
  const decoders = { dracoPath: `${BASE}draco/`, ktx2Path: `${BASE}basis/` };
  let manager: ThreeDManager | undefined;
  let datum = false;
  let layer: ThreeLayer | undefined;
  /** 読んだタイルセット。鍵は Collection ID (1つの行に1つ。LOD・テクスチャを替えたら読み直す)。 */
  const assets = new Map<string, { url: string; loading: Promise<ThreeDTilesAsset | undefined> }>();
  const wanted = new Set<string>();

  /**
   * **キャッシュが満杯になったら知らせる** (1つのタイルセットにつき1回)。描き手 (3d-tiles-renderer) のキャッシュの上限
   * (約430MB・8,000タイル) は固い上限で、満杯になると粗いタイルのまま細かくするのを止める。テクスチャ付きの PLATEAU を
   * 東京駅の周りで見ると、低い建物が抜け、間引かれた欠片が残った (2026-10-14、利用者のスクリーンショット)。
   */
  const warnWhenCacheFull = (asset: ThreeDTilesAsset, collection: Collection, url: string) => {
    const tiles = asset.getTilesRenderer();
    const check = () => {
      if (!tiles.lruCache.isFull()) return;
      tiles.removeEventListener('tiles-load-end', check);
      console.warn('[three] tile cache full; coarse tiles stay for', collection.id, url);
    };
    tiles.addEventListener('tiles-load-end', check);
  };

  /** 高さの基準の格子を読んで始める。**読めなければ補正なしで始め直す** (描けないよりよい)。 */
  const start = async () => {
    try {
      const withDatum = new ThreeDManager({ tilesRendererConfig: decoders });
      await withDatum.init();
      datum = true;
      return withDatum;
    } catch (e) {
      console.warn('[three] vertical datum not loaded; drawing without the geoid correction', e);
      const withoutDatum = new ThreeDManager({ tilesRendererConfig: decoders, verticalDatum: { enabled: false } });
      await withoutDatum.init();
      datum = false;
      return withoutDatum;
    }
  };

  const applyVisibility = () => {
    for (const [id, { loading }] of assets) {
      void loading.then((asset) => {
        if (!asset) return;
        asset.getTilesRenderer().group.visible = wanted.has(id);
        layer?.requestRepaint();
      });
    }
  };

  return {
    attach: async () => {
      manager ??= await start();
      if (!layer) {
        layer = manager.createLayer({ id: LAYER_ID });
        addLights(layer.three.getScene());
      }
      if (!map.getLayer(LAYER_ID)) map.addLayer(layer);
    },
    detach: () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    },
    sync: (tilesets) => {
      wanted.clear();
      for (const { collection } of tilesets) wanted.add(collection.id);
      if (layer) {
        for (const { collection, url } of tilesets) {
          const current = assets.get(collection.id);
          if (current?.url === url) continue;
          // 組み合わせを替えたら、前のものは捨てる (残すとキャッシュを食う)。
          if (current) void current.loading.then((asset) => asset?.destroy());
          const loading = layer
            .load3dTiles({ tilesetUrl: url })
            .then((asset) => {
              warnWhenCacheFull(asset, collection, url);
              asset.getTilesRenderer().addEventListener('load-model', ({ scene }) => shadeUntextured(scene));
              return asset;
            })
            .catch((e: unknown) => {
              console.error('[three] tileset failed', collection.id, e);
              onFailure(collection);
              if (assets.get(collection.id)?.url === url) assets.delete(collection.id);
              return undefined;
            });
          assets.set(collection.id, { url, loading });
        }
      }
      applyVisibility();
    },
    datumApplied: () => datum,
    shown: () => [...assets.keys()].filter((id) => wanted.has(id)),
  };
}
