//! Switzerland – Fedlex (www.fedlex.admin.ch).
//!
//! Swiss federal law is published under ELI URLs, with an Akoma Ntoso XML
//! manifestation (parsed by the shared `akoma` module — Swiss articles use
//! "Art." rather than "Article", which the parser handles since it just reads
//! the `<num>` text). Books are the classified-compilation (SR) numbers. The
//! live content URL is best-effort; the Akoma Ntoso parser is fixture-tested.

use super::akoma;
use super::{fetch_text, FetchedNorm, LegalBook, LegalNorm, LegalResult, LegalSource, SourceInfo};

fn hosts() -> Vec<String> {
    vec!["www.fedlex.admin.ch".to_string(), "fedlex.data.admin.ch".to_string()]
}

fn curated_books() -> Vec<LegalBook> {
    vec![
        LegalBook { id: "210".into(), name: "ZGB – Zivilgesetzbuch".into() },
        LegalBook { id: "220".into(), name: "OR – Obligationenrecht".into() },
        LegalBook { id: "311.0".into(), name: "StGB – Strafgesetzbuch".into() },
        LegalBook { id: "101".into(), name: "BV – Bundesverfassung".into() },
    ]
}

/// Keep only digits and single dots (SR numbers look like "311.0"). Empty
/// segments are dropped, so no ".." can slip into the URL path.
fn sanitize_sr(book: &str) -> String {
    book.chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .split('.')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(".")
}

fn content_url(book: &str) -> String {
    // Fedlex ELI for a classified-compilation act, XML manifestation (best-effort).
    format!("https://www.fedlex.admin.ch/eli/cc/{}/de/xml", sanitize_sr(book))
}

pub struct Fedlex;

#[async_trait::async_trait]
impl LegalSource for Fedlex {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "ch".into(),
            name: "Schweiz (Fedlex)".into(),
            jurisdiction: "CH".into(),
            requires_key: false,
            hosts: hosts(),
        }
    }

    async fn list_books(&self) -> LegalResult<Vec<LegalBook>> {
        Ok(curated_books())
    }

    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>> {
        let xml = fetch_text(&content_url(book), &hosts()).await?;
        Ok(akoma::parse_articles(&xml).into_iter().map(akoma::to_legal_norm).collect())
    }

    async fn fetch_norm(&self, book: &str, norm: &str, _section: &str) -> LegalResult<FetchedNorm> {
        let url = content_url(book);
        let xml = fetch_text(&url, &hosts()).await?;
        let found = akoma::parse_articles(&xml)
            .into_iter()
            .find(|a| a.e_id == norm)
            .ok_or_else(|| format!("article not found: {norm}"))?;
        Ok(FetchedNorm { text: found.text, stand: String::new(), source_url: url })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sr_number_is_sanitized_into_the_url() {
        assert_eq!(sanitize_sr("311.0"), "311.0");
        assert_eq!(sanitize_sr("../101"), "101");
        assert!(content_url("210").contains("/eli/cc/210/de/xml"));
    }

    #[test]
    fn curated_books_cover_the_main_codes() {
        let ids: Vec<String> = curated_books().into_iter().map(|b| b.id).collect();
        assert!(ids.contains(&"210".to_string())); // ZGB
        assert!(ids.contains(&"220".to_string())); // OR
    }
}
