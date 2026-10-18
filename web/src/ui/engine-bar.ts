/**
 * **地図のエンジンを切り替えるバー**。地図の上の真ん中に置く。
 *
 * 切り替えても UI (一覧・カタログ・検索…) は同じで、そのエンジンで描けない行は一覧で灰色になる。
 * エンジンは2種類ある (docs/roadmap.md「エンジン」):
 * - **MapLibre に重ねる** (MapLibre + deck.gl・MapLibre + Three.js): 地図は MapLibre のまま、一部の行を別の描き手が描く
 * - **入れ替える** (Cesium・Navara): 地図そのものが替わる
 */
import type { DrawKind, Draws } from '@japan-geodata-catalog/core/engine';
import { CESIUM_DRAWS } from '@japan-geodata-catalog/cesium/draws';
import { DECKGL_DRAWS } from '@japan-geodata-catalog/deckgl/draws';
import { MAPLIBRE_DRAWS } from '@japan-geodata-catalog/maplibre/draws';
import { NAVARA_DRAWS } from '@japan-geodata-catalog/navara/draws';
import { THREE_DRAWS } from '@japan-geodata-catalog/three/draws';
import { m } from '../i18n';

export type EngineId = 'maplibre' | 'maplibre-deckgl' | 'maplibre-three' | 'cesium' | 'navara';

/** MapLibre に重ねたときに描ける種類 (どちらかが描ければ描ける)。 */
const overlaid = (overlay: Draws): Draws =>
  Object.fromEntries(Object.entries(MAPLIBRE_DRAWS).map(([kind, own]) => [kind, own || overlay[kind as DrawKind]])) as Draws;

/** **エンジンごとの、描ける種類の表。** 一覧の灰色はこれで決める (エンジンの名前では決めない)。 */
const ENGINE_DRAWS: Record<EngineId, Draws> = {
  maplibre: MAPLIBRE_DRAWS,
  'maplibre-deckgl': overlaid(DECKGL_DRAWS),
  'maplibre-three': overlaid(THREE_DRAWS),
  cesium: CESIUM_DRAWS,
  navara: NAVARA_DRAWS,
};

/** その種類の行を描けないエンジンと、一覧で添える理由。 */
export function notDrawnIn(kind: DrawKind): Partial<Record<EngineId, string>> {
  const reasons: Partial<Record<EngineId, string>> = {};
  for (const id of Object.keys(ENGINE_DRAWS) as EngineId[]) {
    if (ENGINE_DRAWS[id][kind]) continue;
    // 3D Tiles は MapLibre の間だけ描けない (描けるエンジンへ案内する)。
    reasons[id] = kind === '3d-tiles' && usesMapLibre(id) ? m.notDrawn3dTilesInMapLibre : m.notDrawnIn(engineLabel(id));
  }
  return reasons;
}

const ENGINES: { id: EngineId; label: string }[] = [
  { id: 'maplibre', label: 'MapLibre' },
  { id: 'maplibre-deckgl', label: '+ deck.gl' },
  { id: 'maplibre-three', label: '+ Three.js' },
  { id: 'cesium', label: 'Cesium' },
  { id: 'navara', label: 'Navara' },
];

/** **MapLibre の地図を使うエンジン** (MapLibre 単体と、MapLibre に重ねるもの)。一覧・検索・吹き出しは MapLibre のまま使える。 */
export const usesMapLibre = (id: EngineId) => id === 'maplibre' || id === 'maplibre-deckgl' || id === 'maplibre-three';

/** バーと文言に出す名前。 */
export const engineLabel = (id: EngineId) =>
  ({ maplibre: 'MapLibre', 'maplibre-deckgl': 'MapLibre + deck.gl', 'maplibre-three': 'MapLibre + Three.js', cesium: 'Cesium', navara: 'Navara' })[id];

/** URL の `engine` を読む。知らない値なら MapLibre。 */
export function engineFromUrl(search: string): EngineId {
  const requested = new URLSearchParams(search).get('engine');
  return ENGINES.find((e) => e.id === requested)?.id ?? 'maplibre';
}

export interface EngineBar {
  /** 選ばれている印を付け直す。 */
  set: (id: EngineId) => void;
  /** 切り替えの途中 (読み込み中) は押せなくする。 */
  setBusy: (busy: boolean) => void;
}

export function createEngineBar(el: HTMLElement, current: EngineId, onSelect: (id: EngineId) => void): EngineBar {
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', m.engineBarLabel);
  const buttons = ENGINES.map(({ id, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.engine = id;
    button.textContent = label;
    button.addEventListener('click', () => onSelect(id));
    el.append(button);
    return { id, button };
  });
  const set = (id: EngineId) => {
    for (const { id: own, button } of buttons) button.setAttribute('aria-pressed', String(own === id));
  };
  set(current);
  el.hidden = false;
  return {
    set,
    setBusy: (busy) => {
      for (const { button } of buttons) button.disabled = busy;
    },
  };
}
