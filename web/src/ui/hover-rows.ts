/**
 * **吹き出しの中身** (行の組み立てと、DOM にするところ)。地図のエンジンに依らない —
 * MapLibre (ui/hover.ts) と Cesium (main.ts) の両方が使う。
 */
// 拡張子を付けておく (単体テストが Node から直接読むため。Node は拡張子を補わない)。
import { m } from '../i18n/index.ts';
import type { Collection } from '../lib/stac.ts';

/** [項目名, 値]。**項目名が空なら見出し**。値が null の行は出さない。 */
export type HoverRows = [string, string | null][];
/** 吹き出しの中身と、**同じものか**の鍵 (同じなら作り直さない — 区間の境でちらつくため)。 */
export type Hover = { key: string; rows: HoverRows };

export const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

/**
 * 外部のベクトルタイル (地理院) の地物1つの吹き出し。`sourceLayer` はタイルの中の層の名前 (`RdCL` など)。
 * 見出しは地物の名前 (注記の文字) があればそれ、無ければ「テーマ › 層」。
 */
export function vectorHover(collection: Collection, sourceLayer: string, props: Record<string, unknown>): Hover {
  const theme = collection.themes?.find((t) => t.layers.some((l) => l.id === sourceLayer));
  const layer = theme?.layers.find((l) => l.id === sourceLayer);
  return {
    key: `vector|${sourceLayer}|${String(props.vt_code ?? '')}|${String(props.vt_text ?? '')}`,
    rows: [
      ['', text(props.vt_text) ?? `${theme?.title ?? ''} › ${layer?.title ?? sourceLayer}`],
      [m.hoverLayer, `${layer?.title ?? sourceLayer} (${sourceLayer})`],
      // 地物の種別のコード。意味は配布元の「地物種別コード一覧」にある。
      [m.hoverTypeCode, text(props.vt_code)],
      [m.hoverSource, `${collection.group?.title ?? ''} ${collection.title}`.trim()],
      [m.hoverVintage, collection.vintage ?? null],
    ],
  };
}

/**
 * 吹き出しの中身を組み立てる。
 *
 * **`setText` に改行を渡しても効かない。** テキストノードになるので `\n` は
 * 空白に潰れ、項目が横一列に並んで読めなくなる。かといって `setHTML` は
 * データ由来の文字列 (駅名や事業者名) をそのままHTMLとして解釈するので使わない。
 * 要素を組んで `setDOMContent` に渡す。
 */
export function hoverContent(rows: HoverRows): HTMLElement {
  const box = document.createElement('div');
  box.className = 'hover-info';
  for (const [label, value] of rows) {
    if (value === null) continue;
    const line = document.createElement('div');
    if (label) {
      const name = document.createElement('span');
      name.className = 'label';
      name.textContent = label;
      line.append(name, document.createTextNode(value));
    } else {
      line.className = 'title';
      line.textContent = value;
    }
    box.append(line);
  }
  return box;
}
