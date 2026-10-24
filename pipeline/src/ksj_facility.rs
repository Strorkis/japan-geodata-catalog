//! **国土数値情報の施設** (学校 P29・市町村役場等及び公的集会施設 P05・医療機関 P04) を GeoParquet にする。
//!
//! どれも点で、Overture の公共施設 (`overture_facilities`) と**同じ列** (名前・種類・分類・住所・出所・ライセンス) にそろえる。
//! 画面の描き方・絞り込み・吹き出し・周辺検索が、そのまま効くようにするため ([`crate::catalog::DatasetKind::Facility`])。
//! 種類 (`category`) の値も Overture のものに寄せる (学校・役所・公民館・病院)。国のデータにしか無い区別 (大学・幼稚園・
//! 診療所・歯科) は種類を足す。
//!
//! 座標は JGD2011 の緯度経度 (EPSG:6668) で配られているので、鉄道 (N02) と同じく WGS84 に変換する。
//! 条件はどれも CC BY 4.0 (2026-10-21 に配布ページで読んだ。複製に承認が要るとは書かれていない)。
use crate::geoparquet;
use anyhow::{Context, Result, bail};
use geo_types::Point;
use proj::Proj;
use std::path::Path;

/// どの国土数値情報か。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KsjFacility {
    /// 医療機関 (P04、2020年度)。
    Medical,
    /// 市町村役場等及び公的集会施設 (P05、2022年)。
    PublicOffice,
    /// 学校 (P29、2023年度)。
    School,
}

impl KsjFacility {
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "P04" => Ok(Self::Medical),
            "P05" => Ok(Self::PublicOffice),
            "P29" => Ok(Self::School),
            other => bail!("知らない国土数値情報です: {other:?} (P04・P05・P29 のどれか)"),
        }
    }

    /// 配信するファイルの名前。カタログはこの接頭辞で種別を決める。
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Medical => "ksj_medical_facilities.parquet",
            Self::PublicOffice => "ksj_public_offices.parquet",
            Self::School => "ksj_schools.parquet",
        }
    }

    /// いつ時点のデータか (配布ページの年度)。
    pub fn vintage(self) -> &'static str {
        match self {
            Self::Medical => "2020年度 (令和2年度)",
            Self::PublicOffice => "2022年 (令和4年)",
            Self::School => "2023年度 (令和5年度)",
        }
    }

    /// 行の出所 (`source`)。Overture の places と同じ列に、どの国土数値情報かを書く。
    fn source(self) -> &'static str {
        match self {
            Self::Medical => "国土数値情報 P04",
            Self::PublicOffice => "国土数値情報 P05",
            Self::School => "国土数値情報 P29",
        }
    }

    /// 属性の名前 (名前・分類のコード・住所)。
    fn keys(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Medical => ("P04_002", "P04_001", "P04_003"),
            Self::PublicOffice => ("P05_003", "P05_002", "P05_004"),
            Self::School => ("P29_004", "P29_003", "P29_005"),
        }
    }

    /// 分類のコードから `(種類, 分類の呼び名)`。**入れないものは None** (各種学校・専修学校は自動車学校などが混ざる)。
    /// コードの一覧は配布元のもの (`MedClassCd`・`PubOfficeCd`・`SchoolClassCd-v2_0`、2026-10-21 に読んだ)。
    fn classify(self, code: &str) -> Result<Option<(&'static str, &'static str)>> {
        let found = match (self, code) {
            (Self::Medical, "1") => Some(("hospital", "病院")),
            (Self::Medical, "2") => Some(("clinic", "診療所")),
            (Self::Medical, "3") => Some(("dental", "歯科診療所")),
            (Self::PublicOffice, "1") => Some(("government", "本庁 (市役所・区役所・町村役場)")),
            (Self::PublicOffice, "2") => Some(("government", "支所・出張所・連絡所")),
            (Self::PublicOffice, "3") => Some(("government", "その他の行政サービス施設")),
            (Self::PublicOffice, "4") => Some(("community", "公立公民館")),
            (Self::PublicOffice, "5") => Some(("community", "集会施設")),
            (Self::School, "16001") => Some(("school", "小学校")),
            (Self::School, "16002") => Some(("school", "中学校")),
            (Self::School, "16003") => Some(("school", "中等教育学校")),
            (Self::School, "16004") => Some(("school", "高等学校")),
            (Self::School, "16005") => Some(("university", "高等専門学校")),
            (Self::School, "16006") => Some(("university", "短期大学")),
            (Self::School, "16007") => Some(("university", "大学")),
            (Self::School, "16011") => Some(("kindergarten", "幼稚園")),
            (Self::School, "16012") => Some(("school", "特別支援学校")),
            (Self::School, "16013") => Some(("kindergarten", "幼保連携型認定こども園")),
            (Self::School, "16014") => Some(("school", "義務教育学校")),
            (Self::School, "16015" | "16016") => None,
            (kind, other) => bail!("{kind:?}: 知らない分類のコードです: {other:?}"),
        };
        Ok(found)
    }
}

/// 1件。座標は WGS84 に変換済み。
#[derive(Debug, Clone)]
pub struct Row {
    pub name: String,
    pub category: &'static str,
    pub class: &'static str,
    pub address: Option<String>,
    pub point: Point<f64>,
}

/// GeoJSON (FeatureCollection) を読む。**分類のコードは文字列でも数でも来る** (P04 は数、P05・P29 は文字列)。
pub fn parse_geojson(kind: KsjFacility, geojson_str: &str) -> Result<Vec<Row>> {
    let geojson: geojson::GeoJson = geojson_str.parse()?;
    let geojson::GeoJson::FeatureCollection(collection) = geojson else {
        bail!("FeatureCollection ではありません");
    };
    let source_epsg = crate::extract_epsg_from_geojson(collection.foreign_members.as_ref())?;
    let (name_key, class_key, address_key) = kind.keys();

    let mut rows = Vec::new();
    for feature in collection.features {
        let props = feature.properties.clone().unwrap_or_default();
        let text = |key: &str| -> Option<String> {
            match props.get(key)? {
                serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            }
        };
        let code = text(class_key).with_context(|| format!("分類 ({class_key}) がありません"))?;
        let Some((category, class)) = kind.classify(&code)? else {
            continue;
        };
        let geometry =
            geo_types::Geometry::<f64>::try_from(feature.geometry.context("形がありません")?)?;
        let geo_types::Geometry::Point(point) = geometry else {
            bail!("点ではない形があります: {geometry:?}");
        };
        rows.push(Row {
            name: text(name_key).with_context(|| format!("名前 ({name_key}) がありません"))?,
            category,
            class,
            address: text(address_key),
            point,
        });
    }
    if rows.is_empty() {
        return Ok(rows);
    }
    let [west, south, east, north] =
        rows.iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, r| {
                [
                    b[0].min(r.point.x()),
                    b[1].min(r.point.y()),
                    b[2].max(r.point.x()),
                    b[3].max(r.point.y()),
                ]
            });
    let proj: Proj = crate::wgs84_transformer(source_epsg, (west, south, east, north))?;
    for row in &mut rows {
        let (x, y) = proj
            .convert((row.point.x(), row.point.y()))
            .context("WGS84 への変換に失敗しました")?;
        row.point = Point::new(x, y);
    }
    Ok(rows)
}

/// 書き出す。列は Overture の公共施設と同じ (名前・種類・分類・住所・出所・ライセンス)。
pub fn write(kind: KsjFacility, rows: Vec<Row>, output: &Path) -> Result<()> {
    let columns = vec![
        geoparquet::utf8_column("name", rows.iter().map(|r| r.name.clone())),
        geoparquet::utf8_column("category", rows.iter().map(|r| r.category.to_string())),
        geoparquet::utf8_column("class", rows.iter().map(|r| r.class.to_string())),
        geoparquet::utf8_nullable_column("address", rows.iter().map(|r| r.address.clone())),
        geoparquet::utf8_column("source", rows.iter().map(|_| kind.source().to_string())),
        geoparquet::utf8_column("license", rows.iter().map(|_| "CC-BY-4.0".to_string())),
    ];
    let points: Vec<Point<f64>> = rows.into_iter().map(|r| r.point).collect();
    let (geometry, bbox, file_bbox) =
        geoparquet::geometry_columns(&points, |p| [p.x(), p.y(), p.x(), p.y()])?;
    geoparquet::write(
        output,
        columns,
        "geometry",
        geometry,
        bbox,
        &["Point".to_string()],
        file_bbox,
        geoparquet::Provenance {
            via: None,
            vintage: Some(kind.vintage()),
            source_lod: None,
            covers: None,
        },
    )
    .with_context(|| format!("書き出しに失敗しました: {}", output.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection(features: &str) -> String {
        format!(
            r#"{{"type":"FeatureCollection","crs":{{"type":"name","properties":{{"name":"urn:ogc:def:crs:EPSG::6668"}}}},"features":[{features}]}}"#
        )
    }

    #[test]
    fn schools_are_grouped_and_vocational_schools_are_left_out() {
        let json = collection(
            r#"{"type":"Feature","properties":{"P29_003":"16001","P29_004":"第一小学校","P29_005":"東京都千代田区1"},"geometry":{"type":"Point","coordinates":[139.75,35.68]}},
               {"type":"Feature","properties":{"P29_003":"16007","P29_004":"東京大学","P29_005":null},"geometry":{"type":"Point","coordinates":[139.76,35.71]}},
               {"type":"Feature","properties":{"P29_003":"16016","P29_004":"ある専修学校","P29_005":"x"},"geometry":{"type":"Point","coordinates":[139.7,35.6]}}"#,
        );
        let rows = parse_geojson(KsjFacility::School, &json).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].category, rows[0].class), ("school", "小学校"));
        assert_eq!(rows[1].category, "university");
        assert_eq!(rows[1].address, None);
        // JGD2011 と WGS84 の差は日本では数cm。
        assert!((rows[0].point.x() - 139.75).abs() < 1e-5);
    }

    #[test]
    fn medical_codes_may_be_numbers() {
        let json = collection(
            r#"{"type":"Feature","properties":{"P04_001":2,"P04_002":"ある診療所","P04_003":"千代田区"},"geometry":{"type":"Point","coordinates":[139.75,35.68]}}"#,
        );
        let rows = parse_geojson(KsjFacility::Medical, &json).unwrap();
        assert_eq!((rows[0].category, rows[0].class), ("clinic", "診療所"));
    }

    #[test]
    fn unknown_codes_are_an_error() {
        let json = collection(
            r#"{"type":"Feature","properties":{"P05_002":"9","P05_003":"x","P05_004":"y"},"geometry":{"type":"Point","coordinates":[139.75,35.68]}}"#,
        );
        assert!(parse_geojson(KsjFacility::PublicOffice, &json).is_err());
    }
}
