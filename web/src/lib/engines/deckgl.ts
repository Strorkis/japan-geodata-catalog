/**
 * **MapLibre + deck.gl。** MapLibre の地図に deck.gl を重ね (`MapboxOverlay`)、**建物 (DuckDB で引いた行) と地形を deck.gl で描く**。
 * 一覧・周辺検索・吹き出しは MapLibre のまま (docs/roadmap.md「エンジン」。MapLibre に重ねる側)。
 *
 * - 建物の MapLibre の層は**消さずに透明にする** — 吹き出しは MapLibre が地物を引き当てて出すので、層があれば効く
 * - **地形は deck.gl の `TerrainLayer`** (利用者の指摘、2026-10-12)。MapLibre の地形は使えない (下の「別の画面」)。
 *   表面には一覧のいちばん上の背景地図を貼る。建物は地形の高さに持ち上げていない (下の SolidPolygonLayer)
 * - **ざっとの段。** ジオメトリは MapLibre に渡すのと同じ GeoJSON の座標を使う。座標の配列を直接渡す (binary) のと、
 *   GeoArrow で受け取るのは次の段 (deck.gl-geoarrow は WKB を受けないので、DuckDB の WKB はいまは自前で読む)
 * - 色は出所ごとの塗りだけ (段の色分けは TOBE)
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Layer } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { SolidPolygonLayer } from '@deck.gl/layers';
import { TerrainLayer } from '@deck.gl/geo-layers';

type Rgba = [number, number, number, number];

/** 出所ごとの塗り (MapLibre の建物の塗りに寄せる)。`palette` はカタログに並んだ順番。 */
const PALETTE: Rgba[] = [
  [74, 128, 200, 230],
  [205, 128, 70, 230],
];

/** Terrarium の標高の読み方 (赤×256 + 緑 + 青/256 − 32768)。 */
const TERRARIUM = { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 };

interface BuildingPolygon {
  polygon: GeoJSON.Position[][];
  height: number;
  palette: number;
}

/** deck.gl で描く地形。標高は Terrarium の XYZ だけ (地理院の独自形式・COG は読めない)。 */
export interface DeckTerrain {
  /** 標高のタイルの URL テンプレート (Terrarium)。 */
  elevation: string;
  maxZoom: number;
  /** 表面に貼る地図タイル (XYZ)。無ければ色だけ。 */
  texture?: string;
}

/** GeoJSON の建物を、押し出す面の並びにする (MultiPolygon は面ごとに分ける)。 */
function toPolygons(features: GeoJSON.Feature[]): BuildingPolygon[] {
  const out: BuildingPolygon[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const height = typeof props.height === 'number' ? props.height : 3;
    const palette = typeof props.palette === 'number' ? props.palette : 0;
    const geometry = feature.geometry;
    if (geometry.type === 'Polygon') out.push({ polygon: geometry.coordinates, height, palette });
    else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) out.push({ polygon, height, palette });
    }
  }
  return out;
}

export interface DeckEngine {
  /** 地図に重ねる。 */
  attach: () => void;
  /** 地図から外す。 */
  detach: () => void;
  /** 建物を描き直す (建物の描き方が引き終えるたびに呼ぶ)。 */
  setBuildings: (features: GeoJSON.Feature[]) => void;
  /** 地形を替える (無ければ平ら)。 */
  setTerrain: (terrain: DeckTerrain | undefined) => void;
  /** E2E のための足がかり (重ねている層の ID)。 */
  layerIds: () => string[];
}

export function createDeckEngine(map: MapLibreMap): DeckEngine {
  // **別の画面 (canvas) に重ねる** (`interleaved: false`)。同じ画面に重ねる方式は、deck.gl 9.4 が MapLibre の内部
  // (`map.transform`) を読み、MapLibre 6 ではそれが無いので落ちた (2026-10-12)。別の画面なら公開の API (getCenter など) だけで動く。
  // 代わりに、地図の文字との前後関係 (深さ) は共有されず、**deck.gl の地形の下に MapLibre のほかの行 (鉄道など) が隠れる** (TOBE)。
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  let attached = false;
  let buildings: BuildingPolygon[] = [];
  let terrain: DeckTerrain | undefined;
  let layers: Layer[] = [];
  const render = () => {
    layers = [];
    if (terrain) {
      layers.push(
        new TerrainLayer({
          id: 'deck-terrain',
          elevationData: terrain.elevation,
          elevationDecoder: TERRARIUM,
          texture: terrain.texture ?? null,
          maxZoom: terrain.maxZoom,
          // 描くだけでなく、ほかの層を乗せる地形にもしておく (TerrainExtension を試すとき用)。
          operation: 'terrain+draw',
          color: [235, 235, 230],
        }),
      );
    }
    layers.push(
      new SolidPolygonLayer<BuildingPolygon>({
        id: 'deck-buildings',
        data: buildings,
        // GeoJSON の座標 (`number[]`) は deck.gl の座標 (`[経度, 緯度]`) と中身が同じ。型だけ合わせる。
        getPolygon: (d) => d.polygon as [number, number][][],
        extruded: true,
        getElevation: (d) => d.height,
        getFillColor: (d) => PALETTE[d.palette] ?? PALETTE[0],
        // **高さ 0 から押し出す。** `TerrainExtension` (地形の高さを足す) を付けると、ヘッドレス (GPU 無し) では建物が消えた
        // (2026-10-12。付けなければ地形の上に出る)。ソフトウェアの描画のせいか、別の画面に重ねる方式との相性かは切り分けていない。
        // 東京駅のように海抜が低い所ではほぼ地面に乗るが、山では浮く・沈む (TOBE: GPU のあるブラウザで拡張を試す)。
        extensions: [],
      }),
    );
    overlay.setProps({ layers });
  };
  return {
    attach: () => {
      if (attached) return;
      map.addControl(overlay);
      attached = true;
      render();
    },
    detach: () => {
      if (!attached) return;
      map.removeControl(overlay);
      attached = false;
    },
    setBuildings: (features) => {
      const started = performance.now();
      buildings = toPolygons(features);
      if (attached) render();
      performance.measure('deck-buildings', { start: started, end: performance.now() });
    },
    setTerrain: (next) => {
      if (next?.elevation === terrain?.elevation && next?.texture === terrain?.texture) return;
      terrain = next;
      if (attached) render();
    },
    layerIds: () => (attached ? layers.map((layer) => layer.id) : []),
  };
}
