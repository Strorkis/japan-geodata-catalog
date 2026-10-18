/**
 * **地図のエンジンとの口。** エンジンの部品 (`packages/{deckgl,three,cesium,navara}`) と、それを使うアプリが共有する型。
 * 手本は GeoLibre の `MapEngine` と `layer-kind.ts` (docs/roadmap.md「ライブラリに分ける」)。
 */
import type { Collection, VectorLayerInfo } from './stac';

/**
 * **地図の見え方。** URL で場所を渡すときと、地図のエンジンを切り替えるときに使う。
 *
 * 意味は MapLibre に合わせる (ズームは 512 画素のタイル、傾きは真上からの度、向きは北から時計回りの度)。
 * Cesium・Navara はそれぞれカメラの距離に直す (`zoom.ts`)。
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

/** 一覧の行を、エンジンが描き分ける種類にしたもの。 */
export type DrawKind =
  /** DuckDB で引いて描く行 (建物・人口メッシュ・鉄道など)。 */
  | 'query'
  /** 地図タイル (XYZ の画像)。 */
  | 'raster-tiles'
  /** スタイルの JSON (MapLibre GL) で描く背景地図。 */
  | 'style'
  /** ベクトルタイル (PMTiles) の線と面。 */
  | 'vector-tiles'
  /** ベクトルタイルの、点だけのテーマ (注記)。文字を描けるかに依る。 */
  | 'vector-points'
  | '3d-tiles';

/**
 * **エンジンが描ける種類の表。** 灰色にする行は、エンジンの名前ではなくこの表で決める。
 * 種類を足すと、全エンジンの表を埋めるまで型で落ちる。
 */
export type Draws = { readonly [K in DrawKind]: boolean };

/** 地図を入れ替えるエンジン (Cesium・Navara) に渡す一覧の行。**上の行ほど上** (一覧の並び) で渡す。 */
export type EngineRow =
  | { kind: 'raster'; collection: Collection; opacity: number }
  /** `url` は読む tileset.json (PLATEAU なら一覧で選んだ LOD・テクスチャの組み合わせ。`plateau-tiles.ts`)。 */
  | { kind: '3d_tiles'; collection: Collection; url: string }
  /** ベクトルタイル。出している層 (テーマをまたいで Collection ごとにまとめる) と、層ごとの色。 */
  | { kind: 'vector'; collection: Collection; layers: { layer: VectorLayerInfo; color: string }[] };

export interface TerrainChoice {
  enabled: boolean;
  /** 地形の欄で選んでいる標高。quantized-mesh を持たなければ、持つもの (Re:Earth Terrain) に替える。 */
  selected: Collection | undefined;
}

/**
 * **地図を入れ替えるエンジン** (Cesium・Navara) の口。地図 (MapLibre) と同じページに置き、バーから切り替えて使う。
 * 見え方の正本は MapLibre で、カメラが止まったら呼ぶ側が MapLibre を合わせる。
 */
export interface SwappedEngine {
  /** 出す。MapLibre の見え方からカメラを置く。 */
  show: (view: View) => Promise<void>;
  /** 隠す (壊さず、描くのを止める)。 */
  hide: () => void;
  /** いまの見え方 (MapLibre の形に直したもの)。 */
  view: () => View;
  /**
   * 一覧の状態を写す。描けない種類の行 (`Draws`) は渡さない。
   * **使う地形** (選んだ標高の代わりに替えたものを含む。平らなら undefined) を返す。
   */
  sync: (rows: EngineRow[], terrain: TerrainChoice) => Collection | undefined;
}
