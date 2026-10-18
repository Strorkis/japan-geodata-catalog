/**
 * **ビルドの側 (Node) で使う部品。** エンジンの部品の Vite のプラグイン (`packages/<エンジン>/vite.ts`) と Web サイトの
 * `vite.config.ts` が、実行時の資産 (Worker・WASM など、バンドラに通さないもの) を写すのに使う。ブラウザでは読まない。
 */
import { copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import type { Connect, Plugin } from 'vite';

/**
 * コピー元とサイズ・更新日時が同じならコピーを飛ばす。
 * DuckDB本体・拡張とも合計100MB超あり、変わっていないものまで毎回コピーすると遅い
 * (node_modules 側もキャッシュ側も、更新されるのは `pnpm update` や
 * バージョン変更のときだけ)。
 */
export function copyFileIfChanged(from: string, to: string): void {
  const original = statSync(from);
  const copied = statSync(to, { throwIfNoEntry: false });
  if (copied?.size === original.size && copied.mtimeMs >= original.mtimeMs) return;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/** ディレクトリを再帰的にコピーする。拡張のキャッシュは version/platform の階層を持つため。 */
export function copyDirIfChanged(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirIfChanged(from, to);
    } else {
      copyFileIfChanged(from, to);
    }
  }
}

/**
 * **依存のパッケージの置き場所** (package.json のあるディレクトリ)。`from` (呼ぶ側の `import.meta.url`) から解決するので、
 * 部品ごとの依存を見る。`exports` に package.json を出していないパッケージもあるので、入口から上へ辿る。
 */
export function packageDir(name: string, from: string): string {
  let dir = dirname(createRequire(from).resolve(name));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (statSync(manifest, { throwIfNoEntry: false }) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name} の package.json が見つかりません`);
    dir = parent;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  // instantiateStreaming がこのContent-Typeを要求する。
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.json': 'application/json',
  // Cesium の資産 (地図の部品の見た目・アイコン・星空の画像など)。
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

/**
 * **開発サーバーで、ディレクトリをそのまま配る** (ビルドでは同じものを写す)。`urlPath` はベースパスからの位置 (`cesium` など)。
 * ディレクトリの外は出さない。
 */
export function serveDirectory(name: string, urlPath: string, root: string): Plugin {
  let mountPath = `/${urlPath}`;
  const handle: Connect.NextHandleFunction = (request, response, next) => {
    // マウントした接頭辞は取り除かれた状態で渡ってくるので、残りがファイル名。
    const relative = normalize(decodeURIComponent((request.url ?? '').split('?')[0].replace(/^\//, '')));
    if (relative.startsWith('..')) return next();
    const file = join(root, relative);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
    const contentType = CONTENT_TYPES[extname(file)];
    if (contentType) response.setHeader('Content-Type', contentType);
    createReadStream(file).pipe(response);
  };
  return {
    name,
    apply: 'serve',
    configResolved(config) {
      mountPath = `${config.base.replace(/\/$/, '')}/${urlPath}`;
    },
    configureServer(server) {
      server.middlewares.use(mountPath, handle);
    },
  };
}
