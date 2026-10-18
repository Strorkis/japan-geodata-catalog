/**
 * **CesiumJS の実行時の資産を配る Vite のプラグイン。** Cesium のエンジン (`src/engine.ts`) が `assetsUrl` で読む。
 * 開発サーバーでは node_modules から配り、ビルドでは出力の `<path>/` に写す。
 * **写して配るので、ライセンス (Apache-2.0) の本文も一緒に置く。**
 */
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { copyDirIfChanged, copyFileIfChanged, packageDir, serveDirectory } from '@japan-geodata-catalog/core/vite';

/** `path` は出力の中の置き場所 (ベースパスからの位置)。エンジンの `assetsUrl` と合わせる。 */
export function cesiumAssets(path = 'cesium'): Plugin[] {
  const cesium = packageDir('cesium', import.meta.url);
  const build = join(cesium, 'Build', 'Cesium');
  return [
    serveDirectory('serve-cesium-assets', path, build),
    {
      name: 'copy-cesium-assets',
      apply: 'build',
      writeBundle(options) {
        const destination = join(options.dir ?? 'dist', path);
        for (const dir of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) {
          copyDirIfChanged(join(build, dir), join(destination, dir));
        }
        copyFileIfChanged(join(cesium, 'LICENSE.md'), join(destination, 'LICENSE.md'));
      },
    },
  ];
}
