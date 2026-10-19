/**
 * 一覧の **地形の行**。
 *
 * **1つだけ選ぶ。** 出すか (チェック) と、どの標高か (選択) を1行で。地図右上の
 * 地形ボタン (TerrainControl) と同じものを切るので、どちらで切っても追随する。
 * 標高の候補はカタログの地形の Collection (Mapterhorn・Re:Earth・地理院…)。
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Collection } from '@japan-geodata-catalog/core/stac';
import { TERRAIN_SOURCE, defaultOf, terrainSource } from '@japan-geodata-catalog/maplibre/tiles';
import { LAYER_ANCHORS, sliderSettings } from './layer-list';
import { m } from '../i18n';

/** 陰影のソースと層 (地形の標高から描く)。 */
const HILLSHADE_SOURCE = 'terrain-hillshade';
const HILLSHADE_LAYER = 'terrain-hillshade';

export interface TerrainRowOptions {
  map: MapLibreMap;
  /** 地形に使える標高。空なら行を隠す。 */
  collections: Collection[];
  /** ⓘ (いま選んでいる標高のカード) を開く。 */
  openDetails: (collection: Collection) => void;
  /**
   * **いま MapLibre が地形を描いてよいか。** deck.gl を重ねている間は deck.gl が地形を描くので、MapLibre の地形は付けない
   * (付けると deck.gl が MapLibre の内部を読んで落ちる)。チェックは「地形を描く」の意味のまま残る。
   */
  mapLibreDrawsTerrain: () => boolean;
}

export interface TerrainRow {
  /** チェックと選択を地図に当て直す (エンジンを替えたとき)。 */
  reapply: () => void;
  /** いま選んでいる標高。 */
  choice: () => Collection | undefined;
}

export function createTerrainRow({ map, collections, openDetails, mapLibreDrawsTerrain }: TerrainRowOptions): TerrainRow {
  const rowEl = document.querySelector<HTMLDivElement>('#terrain-row')!;
  const toggle = document.querySelector<HTMLInputElement>('#terrain-toggle')!;
  const select = document.querySelector<HTMLSelectElement>('#terrain-source')!;
  const settingsButton = document.querySelector<HTMLButtonElement>('#terrain-settings')!;
  const detailButton = document.querySelector<HTMLButtonElement>('#terrain-detail')!;
  const slotEl = document.querySelector<HTMLDivElement>('#terrain-slot')!;
  let exaggeration = 1;
  let choice = defaultOf(collections, 'terrain');
  /** 標高を差し替えている最中 (その間の「地形が外れた」通知は、チェックに写さない)。 */
  let switching = false;

  rowEl.hidden = collections.length === 0;
  for (const collection of collections) {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = `${collection.title} (${collection.group?.title ?? ''})`;
    select.append(option);
  }
  if (choice) select.value = choice.id;
  toggle.checked = map.getTerrain() !== null;

  const apply = () =>
    map.setTerrain(toggle.checked && choice && mapLibreDrawsTerrain() ? { source: TERRAIN_SOURCE, exaggeration } : null);
  toggle.addEventListener('change', apply);
  select.addEventListener('change', () => {
    const next = collections.find((c) => c.id === select.value);
    if (!next || next === choice) return;
    choice = next;
    // **ソースごと差し替える** (URL もエンコードも範囲も標高ごとに違う)。差し替えのために
    // いったん外すが、その通知でチェックを外さない (外すと、付け直されずに地形が消えた)。
    switching = true;
    map.setTerrain(null);
    if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE);
    map.addSource(TERRAIN_SOURCE, terrainSource(next));
    switching = false;
    showHillshade();
    apply();
  });
  // 起伏の強調は ▸ で行の下に開く (地図を見ながら動かすもの)。
  slotEl.append(
    sliderSettings(m.exaggeration, 1, 3, 0.5, 1, (v) => `×${v}`, (v) => {
      exaggeration = v;
      if (map.getTerrain()) apply();
    }),
  );
  // **陰影** (日本の外は背景地図が無く、地形だけでは見えない)。地形とは別のソースから描く
  // (同じソースを共有すると、地形と陰影で細かさの扱いがぶつかることがある)。地図タイルの目印の直下
  // (背景地図より上、データより下) に置く。
  const hillshadeLabel = document.createElement('label');
  hillshadeLabel.className = 'terrain-hillshade';
  const hillshadeToggle = document.createElement('input');
  hillshadeToggle.type = 'checkbox';
  hillshadeToggle.id = 'terrain-hillshade';
  hillshadeLabel.append(hillshadeToggle, document.createTextNode(m.hillshade));
  slotEl.append(hillshadeLabel);
  const showHillshade = () => {
    if (map.getLayer(HILLSHADE_LAYER)) map.removeLayer(HILLSHADE_LAYER);
    if (map.getSource(HILLSHADE_SOURCE)) map.removeSource(HILLSHADE_SOURCE);
    if (!hillshadeToggle.checked || !choice) return;
    map.addSource(HILLSHADE_SOURCE, terrainSource(choice));
    map.addLayer(
      { id: HILLSHADE_LAYER, type: 'hillshade', source: HILLSHADE_SOURCE, paint: { 'hillshade-exaggeration': 0.5 } },
      map.getLayer(LAYER_ANCHORS.tile) ? LAYER_ANCHORS.tile : undefined,
    );
  };
  hillshadeToggle.addEventListener('change', showHillshade);
  settingsButton.addEventListener('click', () => {
    slotEl.hidden = !slotEl.hidden;
    settingsButton.setAttribute('aria-expanded', String(!slotEl.hidden));
    settingsButton.textContent = slotEl.hidden ? '▸' : '▾';
  });
  detailButton.addEventListener('click', () => {
    if (choice) openDetails(choice);
  });
  // 地図右上の地形ボタンで切られたら、一覧のチェックを追随させる。
  // MapLibre が地形を描かない間 (deck.gl) は写さない (外したのはこちらで、利用者ではない)。
  map.on('terrain', () => {
    if (switching || !mapLibreDrawsTerrain()) return;
    toggle.checked = map.getTerrain() !== null;
  });
  return { reapply: apply, choice: () => choice };
}
