/**
 * **場所と施設** (公園・広場・運動場、駐車場・トイレ・水飲み場、公共施設など)。
 *
 * 出所ごとに1行。**種類 (`category`) で絞れる** (選択肢はカタログの語彙から作る。道路の等級と同じ)。
 * 線と同じく**ズームで隠さず**、画面の中心に近い順に上限まで引く (上限は表示量の `placesLimit`)。
 * 面 (公園・駐車場の敷地) と点 (施設) が混ざるので、地図の層は塗り・縁・丸の3つ (ui/map.ts)。
 *
 * 設定 (種類のチェック) は**ここで組み立てる** (サイトの HTML に依らない)。
 */
import type { GeoJSONSource } from 'maplibre-gl';
import type { PlaceSource } from '@japan-geodata-catalog/core/sources';
import { fetchPlacesInView } from '@japan-geodata-catalog/core/queries';
import { EMPTY_FEATURE_COLLECTION, PLACE_COLORS, PLACE_FALLBACK_COLOR } from '../map';
import { requester, type DrawContext } from './context';
import { m } from '../../i18n';

export interface PlaceLayer {
  request: () => void;
  /** 絞り込み (種類のチェック)。一覧の行の ▸ で開く。 */
  settings: HTMLElement;
}

/** 種類の呼び名。語彙に無いものは値のまま。 */
export const placeCategoryLabel = (category: string) => m.placeCategories[category] ?? category;

/** 種類のチェックと、全部・解除。選んでいる種類を返す関数を添える。 */
function categoryPicker(source: PlaceSource, onChange: () => void) {
  const settings = document.createElement('div');
  const field = document.createElement('div');
  field.className = 'field';
  const head = document.createElement('label');
  const title = document.createElement('span');
  title.textContent = m.placeCategory;
  const bulk = document.createElement('span');
  bulk.className = 'bulk';
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = m.selectAll;
  const none = document.createElement('button');
  none.type = 'button';
  none.textContent = m.selectNone;
  bulk.append(all, none);
  head.append(title, bulk);

  const list = document.createElement('div');
  list.className = 'place-categories';
  const inputs = source.categories.map((category) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = category;
    input.checked = true;
    input.addEventListener('change', onChange);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = PLACE_COLORS[category] ?? PLACE_FALLBACK_COLOR;
    label.append(input, swatch, document.createTextNode(placeCategoryLabel(category)));
    list.append(label);
    return input;
  });
  const setAll = (checked: boolean) => {
    for (const input of inputs) input.checked = checked;
    onChange();
  };
  all.addEventListener('click', () => setAll(true));
  none.addEventListener('click', () => setAll(false));
  field.append(head, list);
  settings.append(field);
  return { settings, selected: () => inputs.filter((input) => input.checked).map((input) => input.value) };
}

/** 出所ごとに、描き直しを頼む関数と絞り込みを返す。地図を動かすたびにも描き直す。 */
export function createPlaceLayers(ctx: DrawContext, sources: PlaceSource[]): Map<string, PlaceLayer> {
  const { map } = ctx;
  const layers = new Map<string, PlaceLayer>();
  for (const source of sources) {
    let token = 0;
    let shown = false;
    // 先に要る (チェックを変えたら描き直す)。下で作る request を後から差し込む。
    let request = () => {};
    const picker = categoryPicker(source, () => request());

    const refresh = async () => {
      const mapSource = map.getSource(`place-${source.kind}`) as GeoJSONSource | undefined;
      if (!mapSource) return;
      // 世代は最初に進める (外したあとに読み込み中の結果が描かれないように)。
      const mine = ++token;
      if (!ctx.isVisible(source.id)) {
        if (shown) {
          await mapSource.setData(EMPTY_FEATURE_COLLECTION);
          shown = false;
        }
        ctx.setStatus(source.id, '');
        return;
      }
      const categories = picker.selected();
      const limit = ctx.detail().placesLimit;
      const features = await ctx.busy(m.loadingNamed(source.title), async () => {
        await source.ensure();
        return fetchPlacesInView(ctx.conn, source, ctx.currentBounds(), categories, limit);
      });
      if (mine !== token) return;

      shown = true;
      await mapSource.setData({
        type: 'FeatureCollection',
        features: features.map((feature) => ({
          type: 'Feature',
          properties: {
            name: feature.name,
            category: placeCategoryLabel(feature.category),
            color: PLACE_COLORS[feature.category] ?? PLACE_FALLBACK_COLOR,
            address: feature.address ?? null,
            via: feature.origin ?? null,
            license: feature.license ?? null,
            origin: source.id,
          },
          geometry: feature.geojson,
        })),
      });
      ctx.setStatus(
        source.id,
        categories.length === 0
          ? m.noCategorySelected
          : features.length === 0
            ? m.noneInView
            : m.placeCount(features.length) + (features.length >= limit ? m.displayLimit : ''),
      );
    };

    request = requester(ctx, `place ${source.id}`, source.title, refresh);
    map.on('moveend', request);
    layers.set(source.id, { request, settings: picker.settings });
  }
  return layers;
}
