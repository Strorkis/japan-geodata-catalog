/**
 * **PLATEAU 配信サービスの 3D Tiles の組み合わせ (LOD・テクスチャ) を選ぶ。**
 *
 * 配信サービスは `/datacatalog/3dtiles/{spec}/tileset.json` で、範囲の中の都市を束ねた tileset.json をその場で作る。
 * `{spec}` は `<範囲>-<種類>-<LOD>[-interior][-<テクスチャ>]-<年>`
 * (https://docs.plateauview.mlit.go.jp/api/rest/operations/datacatalog3dtilesspectilesetjson/ 、2026-10-14 に読んだ)。
 *
 * - LOD: `lodN` はちょうど LOD N、`maxlodN` は N 以下で地域ごとにいちばん高いもの
 * - テクスチャ: 省略は「あれば付け、なければ無し」、`notexture` は無しだけ (`texture` はあるものだけで、無い地域が抜けるので選ばせない)
 *
 * **テクスチャ付きの LOD2 は重い。** MapLibre + Three.js の描き手 (3d-tiles-renderer) はキャッシュ (約430MB) が満杯になると
 * 粗いタイルのまま細かくするのを止めるので、東京駅の周りでは低い建物が抜けた。軽い組み合わせを選べるようにする。
 */

export type PlateauLod = 'lod1' | 'maxlod2' | 'maxlod3' | 'maxlod4';
export type PlateauTexture = 'preferred' | 'notexture';

export interface PlateauTilesChoice {
  lod: PlateauLod;
  texture: PlateauTexture;
}

const SPEC = /\/datacatalog\/3dtiles\/([^/]+)\/tileset\.json$/;
const LOD = /^(max)?lod\d$/;

/** spec を分ける。PLATEAU の組み立ての形でなければ undefined。 */
function parse(href: string) {
  const match = SPEC.exec(href);
  if (!match) return undefined;
  const parts = match[1].split('-');
  const lodAt = parts.findIndex((part) => LOD.test(part));
  if (lodAt !== 2 || parts.length < 4) return undefined;
  const rest = parts.slice(3, -1);
  return {
    prefix: href.slice(0, match.index),
    area: parts[0],
    type: parts[1],
    lod: parts[2],
    interior: rest.includes('interior'),
    texture: rest.find((part) => part === 'texture' || part === 'notexture'),
    year: parts[parts.length - 1],
  };
}

/** PLATEAU の組み立ての URL なら、いまの組み合わせを返す (選べる形に寄せる)。そうでなければ undefined。 */
export function plateauTilesChoice(href: string): PlateauTilesChoice | undefined {
  const spec = parse(href);
  if (!spec) return undefined;
  const lod = (['lod1', 'maxlod2', 'maxlod3', 'maxlod4'] as const).find((l) => l === spec.lod) ?? 'maxlod2';
  return { lod, texture: spec.texture === 'notexture' ? 'notexture' : 'preferred' };
}

/**
 * **LOD1 ではテクスチャを選べない。** 配信の一覧 (`/datacatalog/plateau-datasets`、2026-10-14) では、LOD1 の建物の 3D Tiles は
 * 実際にはテクスチャが無いのに、ほとんどが「テクスチャあり」で登録されている (448件。「無し」は3件)。`lod1-notexture` を指定すると
 * ほぼ全部が外れて、何も出なかった (利用者が見つけた)。
 */
export const textureSelectable = (lod: PlateauLod) => lod !== 'lod1';

/** 選んだ組み合わせの URL。PLATEAU の組み立ての形でなければそのまま返す。 */
export function plateauTilesetUrl(href: string, choice: PlateauTilesChoice): string {
  const spec = parse(href);
  if (!spec) return href;
  const parts = [spec.area, spec.type, choice.lod];
  if (spec.interior) parts.push('interior');
  if (choice.texture === 'notexture' && textureSelectable(choice.lod)) parts.push('notexture');
  parts.push(spec.year);
  return `${spec.prefix}/datacatalog/3dtiles/${parts.join('-')}/tileset.json`;
}
