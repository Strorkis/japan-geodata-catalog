use anyhow::{Context, Result, bail};
use japan_geodata_pipeline::ksj_facility::{self, KsjFacility};
use std::io::{Cursor, Read};
use std::path::PathBuf;

/// 国土数値情報の施設 (学校 P29・市町村役場等及び公的集会施設 P05・医療機関 P04) の全国の zip を GeoParquet にする。
///
/// **zip の作りがデータごとに違う。** P04・P29 は全国の GeoJSON が1つ入っている。P05 は都道府県ごとの zip を
/// 束ねた zip で、その中にそれぞれの GeoJSON がある (展開せず、メモリの上で開く)。
/// このあと `optimize_geoparquet` で並べ直す。
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (kind, input, out_dir) = match args.as_slice() {
        [_, kind, input, out_dir] => (
            KsjFacility::parse(kind)?,
            PathBuf::from(input),
            PathBuf::from(out_dir),
        ),
        _ => bail!(
            "usage: ksj_facilities_to_geoparquet <P04|P05|P29> <全国の zip> <出力ディレクトリ>\n\
             例:\n  ksj_facilities_to_geoparquet P29 ../data/ksj/P29/P29-23_GML.zip ../data/overture/places-tmp"
        ),
    };
    let file =
        std::fs::File::open(&input).with_context(|| format!("開けません: {}", input.display()))?;
    let mut archive = zip::ZipArchive::new(file)?;

    let mut rows = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name()?.into_owned();
        if name.ends_with(".geojson") {
            rows.extend(ksj_facility::parse_geojson(kind, &read_text(&mut entry)?)?);
        } else if name.ends_with("_GML.zip") {
            // 都道府県ごとの zip (P05)。
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            let mut inner = zip::ZipArchive::new(Cursor::new(bytes))?;
            for j in 0..inner.len() {
                let mut inner_entry = inner.by_index(j)?;
                if inner_entry.name()?.ends_with(".geojson") {
                    rows.extend(ksj_facility::parse_geojson(
                        kind,
                        &read_text(&mut inner_entry)?,
                    )?);
                }
            }
        }
    }
    if rows.is_empty() {
        bail!(
            "GeoJSON が見つからないか、1件もありません: {}",
            input.display()
        );
    }
    std::fs::create_dir_all(&out_dir)?;
    let output = out_dir.join(kind.file_name());
    let count = rows.len();
    ksj_facility::write(kind, rows, &output)?;
    println!(
        "{count}件を書き出しました ({}): {}",
        kind.vintage(),
        output.display()
    );
    println!("続けて optimize_geoparquet を通すこと。");
    Ok(())
}

fn read_text(entry: &mut impl Read) -> Result<String> {
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .context("GeoJSON は UTF-8 のはずです")?;
    Ok(text)
}
