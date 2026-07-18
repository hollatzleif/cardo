//! Austria – RIS (Rechtsinformationssystem des Bundes, ris.bka.gv.at).
//!
//! The RIS OGD API answers with JSON: `Bundesrecht?Applikation=BrKons&…`
//! returns one `OgdDocumentReference` per §, each carrying an
//! `ArtikelParagraphAnlage` label ("§ 19") and a `DokumentUrl` (the HTML text).
//! Results are paged 100 at a time; we walk a few pages. The JSON is searched
//! recursively for the relevant keys, which stays robust across schema shifts.
//! The parser is fixture-tested; the live query/content is best-effort.

use super::{fetch_text, FetchedNorm, LegalBook, LegalNorm, LegalResult, LegalSource, SourceInfo};
use serde_json::Value;

/// Cap on pages fetched (100 §§ each) so very large codes stay responsive.
const MAX_PAGES: u32 = 5;

fn hosts() -> Vec<String> {
    vec!["data.bka.gv.at".to_string(), "www.ris.bka.gv.at".to_string()]
}

fn curated_books() -> Vec<LegalBook> {
    vec![
        LegalBook { id: "10001622".into(), name: "ABGB – Allgemeines bürgerliches Gesetzbuch".into() },
        LegalBook { id: "10002296".into(), name: "StGB – Strafgesetzbuch".into() },
        LegalBook { id: "10000138".into(), name: "B-VG – Bundes-Verfassungsgesetz".into() },
    ]
}

fn sanitize_number(book: &str) -> String {
    book.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn query_url(gesetzesnummer: &str, page: u32) -> String {
    format!(
        "https://data.bka.gv.at/ris/api/v2.6/Bundesrecht?Applikation=BrKons&Gesetzesnummer={}&DokumenteProSeite=OneHundred&Seitennummer={page}",
        sanitize_number(gesetzesnummer),
    )
}

pub struct Ris;

#[async_trait::async_trait]
impl LegalSource for Ris {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "at".into(),
            name: "Österreich (RIS)".into(),
            jurisdiction: "AT".into(),
            requires_key: false,
            hosts: hosts(),
        }
    }

    async fn list_books(&self) -> LegalResult<Vec<LegalBook>> {
        Ok(curated_books())
    }

    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>> {
        let mut out = Vec::new();
        for page in 1..=MAX_PAGES {
            let json = fetch_text(&query_url(book, page), &hosts()).await?;
            let norms = parse_norms(&json);
            let count = norms.len();
            out.extend(norms.into_iter().map(to_legal_norm));
            if count < 100 {
                break; // last page
            }
        }
        Ok(out)
    }

    async fn fetch_norm(&self, book: &str, norm: &str, _section: &str) -> LegalResult<FetchedNorm> {
        for page in 1..=MAX_PAGES {
            let json = fetch_text(&query_url(book, page), &hosts()).await?;
            let norms = parse_norms(&json);
            let last = norms.len() < 100;
            if let Some(found) = norms.into_iter().find(|n| n.label == norm) {
                let text = if found.content_url.is_empty() {
                    found.label.clone()
                } else {
                    strip_markup(&fetch_text(&found.content_url, &hosts()).await?)
                };
                return Ok(FetchedNorm { text, stand: String::new(), source_url: found.content_url });
            }
            if last {
                break;
            }
        }
        Err(format!("section not found: {norm}"))
    }
}

/* ── Pure JSON parser (fixture-tested) ────────────────────────────────────── */

struct RisNorm {
    label: String,
    content_url: String,
}

fn parse_norms(json: &str) -> Vec<RisNorm> {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let refs = v.pointer("/OgdSearchResult/OgdDocumentResults/OgdDocumentReference");
    let items: Vec<&Value> = match refs {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(obj @ Value::Object(_)) => vec![obj],
        _ => Vec::new(),
    };
    items
        .into_iter()
        .filter_map(|item| {
            let label = find_str(item, "ArtikelParagraphAnlage")
                .or_else(|| find_str(item, "Paragraphnummer").map(|p| format!("§ {p}")))?;
            let content_url = find_str(item, "DokumentUrl").unwrap_or_default();
            Some(RisNorm { label, content_url })
        })
        .collect()
}

/// First string value found for `key` anywhere in the JSON subtree.
fn find_str(v: &Value, key: &str) -> Option<String> {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(s)) = map.get(key) {
                return Some(s.clone());
            }
            map.values().find_map(|val| find_str(val, key))
        }
        Value::Array(arr) => arr.iter().find_map(|val| find_str(val, key)),
        _ => None,
    }
}

fn to_legal_norm(n: RisNorm) -> LegalNorm {
    LegalNorm { id: n.label.clone(), label: n.label }
}

fn strip_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the real RIS Bundesrecht/BrKons response shape.
    const RIS: &str = r##"{
      "OgdSearchResult": { "OgdDocumentResults": { "Hits": { "#text": "2561" }, "OgdDocumentReference": [
        {
          "Data": { "Metadaten": {
            "Allgemein": { "DokumentUrl": "https://www.ris.bka.gv.at/eli/jgs/1811/946/P1/NOR12017691" },
            "Bundesrecht": { "BrKons": { "Paragraphnummer": "1", "ArtikelParagraphAnlage": "§ 1", "Kurztitel": "ABGB" } }
          }}
        },
        {
          "Data": { "Metadaten": {
            "Allgemein": { "DokumentUrl": "https://www.ris.bka.gv.at/eli/jgs/1811/946/P2/NOR12017692" },
            "Bundesrecht": { "BrKons": { "Paragraphnummer": "2", "ArtikelParagraphAnlage": "§ 2" } }
          }}
        }
      ]}}
    }"##;

    #[test]
    fn parses_paragraph_labels_and_doc_urls() {
        let norms = parse_norms(RIS);
        assert_eq!(norms.len(), 2);
        assert_eq!(norms[0].label, "§ 1");
        assert_eq!(norms[0].content_url, "https://www.ris.bka.gv.at/eli/jgs/1811/946/P1/NOR12017691");
        assert_eq!(norms[1].label, "§ 2");
    }

    #[test]
    fn to_legal_norm_uses_the_paragraph_label() {
        let norm = to_legal_norm(parse_norms(RIS).into_iter().next().unwrap());
        assert_eq!(norm.id, "§ 1");
        assert_eq!(norm.label, "§ 1");
    }

    #[test]
    fn strip_markup_removes_tags_and_collapses_space() {
        assert_eq!(strip_markup("<p>Der   <b>Schuldner</b>\n ist</p>"), "Der Schuldner ist");
    }

    #[test]
    fn number_and_query_are_well_formed() {
        assert_eq!(sanitize_number("100/01622"), "10001622");
        let url = query_url("10001622", 2);
        assert!(url.contains("Gesetzesnummer=10001622"));
        assert!(url.contains("DokumenteProSeite=OneHundred"));
        assert!(url.contains("Seitennummer=2"));
    }
}
