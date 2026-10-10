use anyhow::{Context, Result};
use duck_geocoder::plateau_catalog;
use std::path::PathBuf;

/// PLATEAU の配信カタログ (公式 API) から、**都市ごとの名前・都道府県・年度・仕様の版**を写し取る。
///
/// カタログ (`build_catalog`) が PLATEAU の Item に名前と時点を載せるのに使う。Item は ID
/// (`plateau_bldg_13103`) だけだと何の都市か分からず、時点も無かった。
/// **カタログを作るときはネットワークに触らない** (外部の PMTiles のスナップショットと同じ考え方)。
/// 変換した時点のカタログと差が出ないよう、変換し直したら取り直す。
///
/// 変換 (`plateau_bldg_to_geoparquet`) は、これからは年度を GeoParquet の `duck:vintage` にも書く。
/// ファイルに書いてあれば、カタログはそちらを優先する。
fn main() -> Result<()> {
    let output = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("external/plateau-cities.json"));
    let mut cities = plateau_catalog::fetch_catalog()?;
    cities.sort_by(|a, b| a.city_code.cmp(&b.city_code));
    // 1都市1行で書く (差分が読みやすいように)。
    let lines: Vec<String> = cities
        .iter()
        .map(|city| {
            serde_json::to_string(&serde_json::json!({
                "city_code": city.city_code,
                "city": city.city,
                "pref": city.pref,
                "year": city.year,
                "spec": city.spec,
            }))
        })
        .collect::<std::result::Result<_, _>>()?;
    std::fs::write(&output, format!("[\n{}\n]\n", lines.join(",\n")))
        .with_context(|| format!("書けません: {}", output.display()))?;
    println!("{}: {} 都市", output.display(), cities.len());
    Ok(())
}
