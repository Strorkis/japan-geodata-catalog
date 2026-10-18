/**
 * **three.js の Draco と KTX2 (Basis) の読み手を配る Vite のプラグイン。** MapLibre + Three.js (`src/engine.ts`) が
 * `decodersUrl` で読み、3D Tiles の圧縮された形を読むのに使う。補助ライブラリ (maplibre-gl-three) の既定は jsDelivr から読むが、
 * 外へ読みに行かないよう自前で配る。開発サーバーでは node_modules から配り、ビルドでは出力の `<path>/` に写す。
 * **写して配るので、ライセンスの文書も一緒に置く** (three.js は MIT、Draco と Basis は Apache-2.0。各ディレクトリの README に書いてある)。
 */
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { copyDirIfChanged, copyFileIfChanged, packageDir, serveDirectory } from '@japan-geodata-catalog/core/vite';

/** `path` は出力の中の置き場所 (ベースパスからの位置)。エンジンの `decodersUrl` と合わせる。 */
export function threeDecoders(path = 'three'): Plugin[] {
  const three = packageDir('three', import.meta.url);
  const libs = join(three, 'examples', 'jsm', 'libs');
  return [
    serveDirectory('serve-three-decoders', path, libs),
    {
      name: 'copy-three-decoders',
      apply: 'build',
      writeBundle(options) {
        const destination = join(options.dir ?? 'dist', path);
        for (const dir of ['draco', 'basis']) copyDirIfChanged(join(libs, dir), join(destination, dir));
        copyFileIfChanged(join(three, 'LICENSE'), join(destination, 'LICENSE'));
      },
    },
  ];
}
