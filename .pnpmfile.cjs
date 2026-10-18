// pnpm が依存を解くときに、パッケージの package.json を書き換える口 (pnpm の hooks.readPackage)。
//
// **@loaders.gl/textures の「任意の peer」の texture-compressor を外す。** deck.gl の地形 (@deck.gl/geo-layers →
// mesh-layers → gltf → textures) が入れる。@loaders.gl/textures は texture-compressor を JS から import せず、
// Node で別のプロセス (`npx texture-compressor`、lib/encoders/encode-texture.js) として動かすだけで、ブラウザでは使わない。
// それでも依存に書かれているので pnpm が入れてしまい、脆弱性のある image-size 0.7.5 (GHSA-w3rx-r6r6-pgpr) と sprintf-js 1.0.3
// (GHSA-hp3w-g68c-fv3c。直った版が無い) を引き込んでいた。audit では理由を添えて受け入れていたが、Dependabot は
// それを知らずに直そうとして失敗し続けた (2026-10-16)。overrides の `-` は peer には効かなかったので、ここで外す。
// **@loaders.gl/textures が peer から外したら、このファイルごと消す。**
function readPackage(pkg) {
  if (pkg.name === '@loaders.gl/textures') {
    // 4.5 は任意の peer、4.4 (ほかの部品が入れる古い版) は普通の依存に書いている。
    delete pkg.dependencies?.['texture-compressor'];
    delete pkg.peerDependencies?.['texture-compressor'];
    delete pkg.peerDependenciesMeta?.['texture-compressor'];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
