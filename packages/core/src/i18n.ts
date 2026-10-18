/**
 * **言語の決め方と、core が使う文言。** 言語は `?lang=ja|en` があればそれ、無ければブラウザの言語で決める
 * (日本語でなければ英語)。Web サイトの文言 (`web/src/i18n/`) もここの `lang` を使うので、core と画面で言語がずれない。
 *
 * core の文言は、問い合わせの結果やカタログの読み取りに添える短いものだけ (画面の文言は Web サイトが持つ)。
 * 日本語と英語は同じ形で、**英語が抜けていたら型で落ちる**。
 */

export type Lang = 'ja' | 'en';

/** URL の `lang` → ブラウザの言語、の順で決める。 */
export function detectLang(search: string, languages: readonly string[]): Lang {
  const requested = new URLSearchParams(search).get('lang');
  if (requested === 'ja' || requested === 'en') return requested;
  return languages[0]?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export const lang: Lang =
  typeof window === 'undefined' ? 'ja' : detectLang(window.location.search, navigator.languages ?? []);

const ja = {
  /** 粗い段で描いているときの注記 (sources.ts)。 */
  simplifiedNote: (zoom: number) => ` · 簡略表示 (ズーム${zoom}から原寸)`,
  /** 原典が表示より細かい LOD を持つときの注記 (sources.ts)。 */
  sourceLodNote: (shown: number, max: number) => ` · 表示はLOD${shown} / 原典はLOD${max}まで`,
  /** 道路の路線の区間の数 (search.ts)。Web サイトにも同じものがある (道路・線の行)。 */
  segmentCount: (count: number) => `${count.toLocaleString()} 区間`,
  /** 段の無い出所の「段」の題名 (nearby.ts)。 */
  allTiers: 'すべて',
  /** CityGML の地物の種類の呼び名 (plateau-api.ts)。PLATEAU の配信 API が返す種類のうち、よく出るもの。 */
  citygmlTypes: {
    bldg: '建物',
    tran: '道路',
    rwy: '鉄道',
    brid: '橋',
    luse: '土地利用',
    dem: '地形',
    fld: '洪水浸水想定',
    tnm: '津波浸水想定',
    htd: '高潮浸水想定',
    lsld: '土砂災害警戒区域',
    urf: '都市計画決定',
    veg: '植生',
    frn: '都市設備',
    ubld: '地下街',
    wwy: '航路',
  } as Readonly<Record<string, string>>,
};

type CoreMessages = typeof ja;

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const en: CoreMessages = {
  simplifiedNote: (zoom) => ` · simplified (full detail from zoom ${zoom})`,
  sourceLodNote: (shown, max) => ` · shown at LOD${shown} / source up to LOD${max}`,
  segmentCount: (n) => count(n, 'segment', 'segments'),
  allTiers: 'All',
  citygmlTypes: {
    bldg: 'Buildings',
    tran: 'Roads',
    rwy: 'Railways',
    brid: 'Bridges',
    luse: 'Land use',
    dem: 'Terrain',
    fld: 'Flood inundation',
    tnm: 'Tsunami inundation',
    htd: 'Storm surge inundation',
    lsld: 'Landslide warning areas',
    urf: 'Urban planning',
    veg: 'Vegetation',
    frn: 'City furniture',
    ubld: 'Underground malls',
    wwy: 'Waterways',
  },
};

/** いまの言語の、core の文言。 */
export const m: CoreMessages = { ja, en }[lang];
