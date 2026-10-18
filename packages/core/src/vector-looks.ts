/**
 * ベクトルタイルのテーマごとの色。MapLibre (tiles.ts) と Cesium (packages/cesium へ main.ts が渡す) で共用する。
 * MapLibre を読み込まないよう、色の表だけをここに分けた。
 */

/** テーマの見え方。色は1つで、形 (面・線・点) で描き分ける。 */
export interface VectorLook {
  color: string;
  /** 線を破線にするか (境界・送電線)。 */
  dash?: number[];
}

/**
 * テーマごとの色。**見え方は UI の持ち物**なので、カタログには書かない。
 * 知らないテーマは既定の色で描く (テーマが増えても描けなくはならない)。
 */
const VECTOR_THEME_LOOKS: Record<string, VectorLook> = {
  anno: { color: '#333333' },
  road: { color: '#b8733e' },
  rail: { color: '#555555' },
  building: { color: '#8c7b6b' },
  water: { color: '#3b7dd8' },
  terrain: { color: '#a0794f' },
  boundary: { color: '#8b4fa8', dash: [3, 2] },
  structure: { color: '#7a7a7a' },
  power: { color: '#d19a00', dash: [4, 2] },
};
const DEFAULT_VECTOR_LOOK: VectorLook = { color: '#666666' };

export const vectorThemeLook = (themeId: string): VectorLook => VECTOR_THEME_LOOKS[themeId] ?? DEFAULT_VECTOR_LOOK;
