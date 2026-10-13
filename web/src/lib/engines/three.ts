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
import type { Collection } from '../stac';

const LAYER_ID = 'three-3d-tiles';
const BASE = `${import.meta.env.BASE_URL}three/`;

export interface ThreeEngine {
  /** 地図に重ねる (初回は高さの基準の格子を読む)。 */
  attach: () => Promise<void>;
  /** 地図から外す (読んだタイルは残す)。 */
  detach: () => void;
  /** 描く 3D Tiles を一覧に合わせる。 */
  sync: (collections: Collection[]) => void;
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
  const assets = new Map<string, Promise<ThreeDTilesAsset | undefined>>();
  const wanted = new Set<string>();

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
    for (const [id, loading] of assets) {
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
      layer ??= manager.createLayer({ id: LAYER_ID });
      if (!map.getLayer(LAYER_ID)) map.addLayer(layer);
    },
    detach: () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    },
    sync: (collections) => {
      wanted.clear();
      for (const collection of collections) wanted.add(collection.id);
      if (layer) {
        for (const collection of collections) {
          if (assets.has(collection.id)) continue;
          assets.set(
            collection.id,
            layer.load3dTiles({ tilesetUrl: collection.tileLink!.href }).catch((e: unknown) => {
              console.error('[three] tileset failed', collection.id, e);
              onFailure(collection);
              assets.delete(collection.id);
              return undefined;
            }),
          );
        }
      }
      applyVisibility();
    },
    datumApplied: () => datum,
    shown: () => [...assets.keys()].filter((id) => wanted.has(id)),
  };
}
