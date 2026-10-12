/**
 * **PMTiles を Cesium の `MVTDataProvider` に渡す中継。**
 *
 * `MVTDataProvider` (CesiumJS 1.146・実験段階) は `{z}/{x}/{y}` の URL テンプレートしか受けない。
 * PMTiles は1つのファイルを Range で読むので、決まった形の URL だけを `Resource` の取得の口で横取りし、
 * `pmtiles` から該当のタイルを返す。それ以外の URL は元の取得に任せる。
 *
 * - `Resource._Implementations.loadWithXhr` は Cesium の内部の口 (公開 API ではない)。
 *   **Cesium の版を上げたら、E2E (3D のページのベクトルタイル) で効いていることを確かめる。**
 *   Cesium に PMTiles の口ができれば、この中継は要らない
 * - 無いタイルは 404 で返す。`MVTDataProvider` はそれを空のタイルとして扱う
 */
import { RequestErrorEvent, Resource } from 'cesium';
import { PMTiles } from 'pmtiles';

const RELAY_HOST = 'https://pmtiles.invalid/';
const archives = new Map<string, PMTiles>();

/** Cesium が `{z}/{x}/{y}` を埋めて取りに来る URL の形。 */
const RELAY_URL = /^https:\/\/pmtiles\.invalid\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/;

type LoadWithXhr = (
  url: string,
  responseType: XMLHttpRequestResponseType | undefined,
  method: string | undefined,
  data: unknown,
  headers: unknown,
  deferred: { resolve: (value: unknown) => void; reject: (reason: unknown) => void },
  overrideMimeType: string | undefined,
) => unknown;

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  const implementations = (Resource as unknown as { _Implementations: { loadWithXhr: LoadWithXhr } })._Implementations;
  const original = implementations.loadWithXhr;
  implementations.loadWithXhr = (url, responseType, method, data, headers, deferred, overrideMimeType) => {
    const match = RELAY_URL.exec(url);
    if (!match) return original(url, responseType, method, data, headers, deferred, overrideMimeType);
    const archive = archives.get(match[1]);
    if (!archive) {
      deferred.reject(new RequestErrorEvent(404));
      return undefined;
    }
    archive
      .getZxy(Number(match[2]), Number(match[3]), Number(match[4]))
      .then((tile) => (tile ? deferred.resolve(tile.data) : deferred.reject(new RequestErrorEvent(404))))
      .catch((e) => deferred.reject(e));
    return undefined;
  };
}

/**
 * PMTiles を `MVTDataProvider.fromUrl` に渡せる URL テンプレートにする。
 * 同じ Collection は1つの `PMTiles` を使い回す (ヘッダとディレクトリのキャッシュが効く)。
 */
export function pmtilesTemplate(collectionId: string, pmtilesUrl: string): string {
  install();
  if (!archives.has(collectionId)) archives.set(collectionId, new PMTiles(pmtilesUrl));
  return `${RELAY_HOST}${collectionId}/{z}/{x}/{y}.pbf`;
}
