/**
 * **地図のエンジンを切り替えるバー** (MapLibre | Cesium | Navara)。地図の上の真ん中に置く。
 *
 * 切り替えても UI (一覧・カタログ・検索…) は同じで、そのエンジンで描けない行は一覧で灰色になる。
 * Navara はまだ無いので押せない (TOBE)。
 */
import { m } from '../i18n';

export type EngineId = 'maplibre' | 'cesium' | 'navara';

const ENGINES: { id: EngineId; label: string; ready: boolean }[] = [
  { id: 'maplibre', label: 'MapLibre', ready: true },
  { id: 'cesium', label: 'Cesium', ready: true },
  { id: 'navara', label: 'Navara', ready: false },
];

/** URL の `engine` を読む。知らない値や、まだ無いエンジンなら MapLibre。 */
export function engineFromUrl(search: string): EngineId {
  const requested = new URLSearchParams(search).get('engine');
  return ENGINES.find((e) => e.id === requested && e.ready)?.id ?? 'maplibre';
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
  const buttons = ENGINES.map(({ id, label, ready }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.engine = id;
    button.textContent = label;
    if (!ready) {
      button.disabled = true;
      button.title = m.engineComingSoon(label);
    }
    button.addEventListener('click', () => onSelect(id));
    el.append(button);
    return { id, ready, button };
  });
  const set = (id: EngineId) => {
    for (const { id: own, button } of buttons) button.setAttribute('aria-pressed', String(own === id));
  };
  set(current);
  el.hidden = false;
  return {
    set,
    setBusy: (busy) => {
      for (const { ready, button } of buttons) button.disabled = busy || !ready;
    },
  };
}
