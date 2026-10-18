/**
 * **Navara の Worker が読む WASM を、Worker の隣 (`assets/`) に置く Vite のプラグイン。** Navara の Worker (`index-*.js`・
 * `fontWorker-*.js`) は Draco の読み手と文字の描き手の WASM を `new URL('…wasm', self.location.href)` で**自分の隣から**読む。
 * Vite は Worker をただのファイルとして写すので、その中の参照には気付かず WASM を出力しない。公開サイトでは 404 の HTML を
 * WASM として読んで `expected magic word 00 61 73 6d, found 3c 21 44 4f` (`<!DO`) で落ちた (2026-10-16、利用者が見つけた。
 * 開発サーバーは node_modules から配るので起きない)。名前 (ハッシュ付き) は Navara が付けたままで写す。Navara の版を上げたら、
 * 本番ビルドで Worker の参照が全部あるかを確かめる (docs/roadmap.md)。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { copyFileIfChanged, packageDir } from '@japan-geodata-catalog/core/vite';

export function navaraWorkerWasm(): Plugin {
  const source = join(packageDir('@navaramap/three', import.meta.url), 'dist', 'assets');
  return {
    name: 'copy-navara-worker-wasm',
    apply: 'build',
    writeBundle(options, bundle) {
      const destination = join(options.dir ?? 'dist', 'assets');
      for (const file of readdirSync(source).filter((name) => name.endsWith('.wasm'))) {
        copyFileIfChanged(join(source, file), join(destination, file));
      }
      // **写し忘れはビルドで止める。** Worker が自分の隣から読むもの (`new URL(\`名前\`, self.location.href)`) が
      // 出力に無ければ失敗にする。Draco の読み手は圧縮されたタイルが届くまで読まれないので、E2E では見えない。
      const missing = new Set<string>();
      // Navara の Worker は Vite から見るとただのファイル (asset) として出る。JS のもの (chunk) と両方を見る。
      for (const output of Object.values(bundle)) {
        if (!output.fileName.endsWith('.js')) continue;
        const code = output.type === 'chunk' ? output.code : Buffer.from(output.source).toString('utf8');
        for (const [, name] of code.matchAll(/new URL\(`([^`/:]+)`,\s*self\.location\.href\)/g)) {
          if (!statSync(join(destination, name), { throwIfNoEntry: false })) missing.add(`${name} (${output.fileName})`);
        }
      }
      if (missing.size > 0) {
        this.error(`Worker が読むファイルが出力にありません: ${[...missing].join(', ')}`);
      }
    },
  };
}
