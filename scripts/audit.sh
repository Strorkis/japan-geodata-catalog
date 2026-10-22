#!/bin/sh
# 依存の脆弱性を見る。コミット前にhookから呼ばれる (.claude/settings.json)。
#
# **見つかったらコミットを止める。** pushしてGitHubに指摘されて初めて気づく、
# という流れを避けるため。判断のうえで受け入れるものは、無視せず設定に書く:
#
#   Rust : pipeline/.cargo/audit.toml (crates/remote-zip は crates/remote-zip/.cargo/audit.toml) の ignore に、
#          理由と外せる条件を添えて足す
#   npm  : pnpm-workspace.yaml (リポジトリの直下) の auditConfig.ignoreGhsas に足す (pnpm 11 は package.json の
#          "pnpm" を読まない。GitHub の番号 (GHSA) しか付いていないものも多いので CVE ではなく GHSA で書く)
#   Python: このスクリプトの pip-audit に --ignore-vuln を、理由を添えて足す
#
# どれも「なぜ受け入れたか」がリポジトリに残る形にすること。
#
# **lockfile は4つある** (npm・pipeline・crates/remote-zip・uv)。2026-10-22 までは remote-zip と uv を見ておらず、
# pipeline で直した rustls の脆弱性が remote-zip に残り、Pillow の24件にも気付かなかった。
set -e
cd "$(dirname "$0")/.."

status=0

echo "== web・packages (npm) =="
# pnpm audit は見つかると非0で終わる。ここで止めずに両方見たいので拾っておく。
# ワークスペースの起点 (直下) で流す (lockfile が1つなので、Web サイトと packages/* をまとめて見る)。
mise exec -- pnpm audit || status=1

echo
echo "== pipeline (Rust) =="
(cd pipeline && mise exec -- cargo audit) || status=1

echo
echo "== crates/remote-zip (Rust) =="
(cd crates/remote-zip && mise exec -- cargo audit) || status=1

echo
echo "== 参考資料を読む道具 (Python) =="
# uv.lock を書き出して pip-audit (PyPI の脆弱性の情報を引く) に渡す。pip-audit は uvx で一時的に動かす (入れたままにしない)。
# 依存はもう uv.lock で決まっているので、解決し直さずに (`--no-deps`) その版だけを見る。
reqs=$(mktemp)
mise exec -- uv export --format requirements-txt --no-hashes --quiet > "$reqs"
mise exec -- uvx --quiet pip-audit --requirement "$reqs" --disable-pip --no-deps || status=1
rm -f "$reqs"

echo
echo "== 道具の版 (mise。知らせるだけで止めない) =="
# mise.toml は版を固定している (2026-10-22 から)。新しい版が出ていたら知らせる。セキュリティの更新なら
# `mise upgrade --bump <道具>` で上げ、Node.js・pnpm・Rust は CI の版も揃える (mise.toml の先頭)。
# Node.js は LTS の版から選ぶ (mise は LTS でない新しい版も出す)。mise は場所を `~/…` の形で書くので、ディレクトリ名で絞る。
outdated=$(mise outdated --bump 2>/dev/null | grep -F "/$(basename "$(pwd)")/mise.toml" || true)
if [ -n "$outdated" ]; then
  echo "新しい版があります (意図して上げる):"
  echo "$outdated"
else
  echo "道具は最新です。"
fi

echo
if [ "$status" -ne 0 ]; then
  echo "脆弱性が見つかりました。直すか、理由を添えて設定に記録してください。" >&2
else
  echo "脆弱性はありません。"
fi
exit "$status"
