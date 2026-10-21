use anyhow::{Context, Result, bail};
use japan_geodata_pipeline::geoparquet::{
    CoveringBbox, geo_metadata_json, geoparquet_geometry_type,
};
use japan_geodata_pipeline::overture::{
    DEFAULT_RELEASE, OverturePlace, build_places_sql, build_places_stats_sql,
};
use std::path::PathBuf;
use std::process::Command;

/// `extract_overture open_space|amenity|facility` で落としたファイルから、日本の場所と施設のデータセットを作る。
///
/// 送電線・川 ([`overture_lines_to_geoparquet`]) と同じ流れ。base 由来 (公園・駐車場など) は**国外を市区町村との
/// 交差で落とし**、places 由来 (公共施設) は取り出すときに住所の国で絞ってある。
/// このあと `optimize_geoparquet` で並べ直す。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (place, input, divisions, out_dir) = match args.as_slice() {
        [_, kind, input, divisions, out_dir] => (
            OverturePlace::parse(kind)?,
            input.clone(),
            divisions.clone(),
            PathBuf::from(out_dir),
        ),
        _ => bail!(
            "usage: overture_places_to_geoparquet <open_space|amenity|facility> <取り出したparquet> \
             <divisions_jp.parquet> <出力ディレクトリ>\n\
             例:\n  \
             overture_places_to_geoparquet open_space ../data/overture/open_space_jp.parquet \\\n    \
             ../data/overture/divisions_jp.parquet ../data/output/overture"
        ),
    };
    std::fs::create_dir_all(&out_dir)?;
    let vintage = std::env::var("OVERTURE_RELEASE").unwrap_or_else(|_| DEFAULT_RELEASE.to_string());

    let output = out_dir.join(place.file_name());
    let output_str = output.to_str().context("出力パスがUTF-8ではありません")?;

    // 収録範囲とジオメトリ種別は決め打ちせず、実データから取る。
    let stats = query_stats(&build_places_stats_sql(place, &input, &divisions))?;
    let geometry_types = stats
        .geometry_types
        .iter()
        .map(|name| geoparquet_geometry_type(name).map(str::to_string))
        .collect::<Result<Vec<_>>>()?;
    println!(
        "{place:?}: 収録範囲 [{}, {}, {}, {}] / ジオメトリ {}",
        stats.xmin,
        stats.ymin,
        stats.xmax,
        stats.ymax,
        geometry_types.join(", "),
    );

    let covering = CoveringBbox {
        column: "bbox".to_string(),
        xmin: "xmin".to_string(),
        ymin: "ymin".to_string(),
        xmax: "xmax".to_string(),
        ymax: "ymax".to_string(),
    };
    let geo = geo_metadata_json(
        "geometry",
        &covering,
        &geometry_types,
        [stats.xmin, stats.ymin, stats.xmax, stats.ymax],
    )?;
    run_duckdb(&build_places_sql(
        place, &input, &divisions, output_str, &geo, &vintage,
    ))?;
    println!("書き出しました: {}", output.display());
    println!("続けて optimize_geoparquet を通すこと。");
    Ok(())
}

#[derive(serde::Deserialize)]
struct Stats {
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    geometry_types: Vec<String>,
}

fn query_stats(sql: &str) -> Result<Stats> {
    let output = Command::new("duckdb")
        .args(["-json", "-c", sql])
        .output()
        .context("duckdb コマンドを実行できません (mise install は済んでいますか?)")?;
    if !output.status.success() {
        bail!(
            "duckdb が失敗しました: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let rows: Vec<Stats> =
        serde_json::from_slice(&output.stdout).context("duckdb の出力を読めません")?;
    rows.into_iter()
        .next()
        .context("日本の場所や施設が1件も見つかりません")
}

fn run_duckdb(sql: &str) -> Result<()> {
    let status = Command::new("duckdb")
        .arg("-c")
        .arg(sql)
        .status()
        .context("duckdb コマンドを実行できません")?;
    if !status.success() {
        bail!("duckdb が失敗しました: {status}");
    }
    Ok(())
}
