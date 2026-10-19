use anyhow::{Context, Result, bail};
use japan_geodata_pipeline::overture::{DEFAULT_RELEASE, JAPAN_BBOX};
use japan_geodata_pipeline::quadkey;
use std::path::PathBuf;
use std::process::Command;

/// **日本の Overture の建物が、実際にどの出所から来ているか**を数える。
///
/// 出典の文言 (catalog.rs の `OVERTURE_BUILDINGS`) は、Overture が挙げている出所を全部並べていた。
/// 取り出し (`extract_overture`) で `sources` 列を落としていて、日本に何が入っているか数えていなかったため。
///
/// - 手元の建物 (日本の分だけ。`overture_buildings_to_geoparquet` が日本のタイルだけを残した) から、
///   ズーム12のタイルの一覧を作る (取り出しの範囲には韓国や中国の一部も入っているので、それを除く)
/// - Overture の公開データから、範囲内の建物の**形の出所** (`sources` のうち `property` が空のもの) を
///   ズーム12のタイルごとに数える。読むのは `bbox` と `sources` の列だけ
/// - 手元のタイルに入るものだけを足す
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dir = match args.as_slice() {
        [_, dir] => PathBuf::from(dir),
        _ => bail!(
            "usage: count_overture_sources <配信ディレクトリ>\n\n\
             日本の Overture の建物の出所を数える (OVERTURE_RELEASE で版を変えられる)。\n\n\
             例:\n  count_overture_sources ../data/output"
        ),
    };
    let release = std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string());
    let local = dir
        .join("overture")
        .join("overture_buildings_[0-9]*.parquet");
    let local = local.to_str().context("パスがUTF-8ではありません")?;
    let center = |b: &str| {
        quadkey::sql_expression(
            &format!("({b}.xmin + {b}.xmax) / 2"),
            &format!("({b}.ymin + {b}.ymax) / 2"),
            12,
        )
    };
    let local_key = center("bbox");
    let remote_key = center("bbox");
    let b = JAPAN_BBOX;
    let sql = format!(
        "INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';
SET memory_limit = '2GB';
CREATE TABLE japan AS SELECT DISTINCT {local_key} AS tile FROM read_parquet('{local}');
CREATE TABLE remote AS
  SELECT {remote_key} AS tile,
    coalesce(list_filter(sources, lambda s: coalesce(s.property, '') = '')[1].dataset, '(不明)') AS dataset,
    count(*) AS n
  FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*', hive_partitioning = 1)
  WHERE bbox.xmin BETWEEN {xmin} AND {xmax} AND bbox.ymin BETWEEN {ymin} AND {ymax}
  GROUP BY ALL;
SELECT dataset, sum(n)::BIGINT AS buildings, round(100.0 * sum(n) / sum(sum(n)) OVER (), 2) AS percent
FROM remote JOIN japan USING (tile)
GROUP BY dataset ORDER BY buildings DESC;",
        xmin = b.xmin,
        xmax = b.xmax,
        ymin = b.ymin,
        ymax = b.ymax,
    );
    println!("Overture {release} の日本の建物の出所 (形の出所ごとの棟数):");
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(sql)
        .status()
        .context("duckdb を実行できません")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }
    Ok(())
}
