/**
 * **地図のエンジンを切り替えるバー**。地図の上の真ん中に置く。
 *
 * 切り替えても UI (一覧・カタログ・検索…) は同じで、そのエンジンで描けない行は一覧で灰色になる。
 * エンジンは2種類ある (docs/roadmap.md「エンジン」):
 * - **MapLibre に重ねる** (MapLibre + deck.gl・MapLibre + Three.js): 地図は MapLibre のまま、一部の行を別の描き手が描く
 * - **入れ替える** (Cesium・Navara): 地図そのものが替わる
 */
import { m } from '../i18n';

export type EngineId = 'maplibre' | 'maplibre-deckgl' | 'maplibre-three' | 'cesium' | 'navara';

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
