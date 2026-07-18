//! European Union – EUR-Lex (Publications Office).
//!
//! EU acts are addressed by CELEX number. The structured Akoma Ntoso/Formex
//! manifestations are awkward to fetch; the HTML rendering, however, marks each
//! article with `<div class="eli-subdivision" id="art_N">`, which is stable and
//! easy to slice. So we list articles by their `art_N` ids and extract each
//! article's text as the HTML between its marker and the next article's. EU
//! legislation is free to reuse (Commission Decision 2011/833/EU). Parsing is
//! pure and fixture-tested; the live URL is best-effort.

use super::{fetch_text, FetchedNorm, LegalBook, LegalNorm, LegalResult, LegalSource, SourceInfo};

fn hosts() -> Vec<String> {
    vec!["eur-lex.europa.eu".to_string()]
}

fn curated_books() -> Vec<LegalBook> {
    vec![
        LegalBook { id: "32016R0679".into(), name: "GDPR – General Data Protection Regulation".into() },
        LegalBook { id: "32000L0031".into(), name: "e-Commerce Directive 2000/31/EC".into() },
        LegalBook { id: "32019L0790".into(), name: "Copyright in the Digital Single Market (2019/790)".into() },
    ]
}

fn sanitize_celex(book: &str) -> String {
    book.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

fn content_url(celex: &str) -> String {
    format!("https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:{celex}")
}

pub struct EurLex;

#[async_trait::async_trait]
impl LegalSource for EurLex {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "eu".into(),
            name: "Europäische Union (EUR-Lex)".into(),
            jurisdiction: "EU".into(),
            requires_key: false,
            hosts: hosts(),
        }
    }

    async fn list_books(&self) -> LegalResult<Vec<LegalBook>> {
        Ok(curated_books())
    }

    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>> {
        let html = fetch_text(&content_url(&sanitize_celex(book)), &hosts()).await?;
        Ok(article_ids(&html).into_iter().map(to_legal_norm).collect())
    }

    async fn fetch_norm(&self, book: &str, norm: &str, _section: &str) -> LegalResult<FetchedNorm> {
        let url = content_url(&sanitize_celex(book));
        let html = fetch_text(&url, &hosts()).await?;
        let text = extract_article(&html, norm)
            .ok_or_else(|| format!("article not found: {norm}"))?;
        Ok(FetchedNorm { text, stand: String::new(), source_url: url })
    }
}

/* ── Pure HTML parser (fixture-tested) ────────────────────────────────────── */

const ART_MARKER: &str = "id=\"art_";

/// A top-level article id suffix is digits + an optional trailing letter
/// (`art_1`, `art_1a`) – NOT a nested subdivision like `art_1.001`.
fn is_article_suffix(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().next().is_some_and(|b| b.is_ascii_digit())
        && s.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// Byte index of the next top-level article marker at/after `from`, if any.
fn next_article_marker(html: &str, from: usize) -> Option<usize> {
    let mut search = from;
    while let Some(rel) = html[search..].find(ART_MARKER) {
        let marker_pos = search + rel;
        let idx = marker_pos + "id=\"".len();
        let qlen = html[idx..].find('"')?;
        let suffix = html[idx..idx + qlen].strip_prefix("art_").unwrap_or("");
        if is_article_suffix(suffix) {
            return Some(marker_pos);
        }
        search = idx + qlen; // nested art id – keep looking
    }
    None
}

/// Every distinct top-level article id in document order.
fn article_ids(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut start = 0;
    while let Some(pos) = next_article_marker(html, start) {
        let idx = pos + "id=\"".len();
        let Some(qlen) = html[idx..].find('"') else { break };
        let id = html[idx..idx + qlen].to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
        start = idx + qlen;
    }
    ids
}

fn to_legal_norm(id: String) -> LegalNorm {
    let num = id.strip_prefix("art_").unwrap_or(&id);
    LegalNorm { label: format!("Article {num}"), id }
}

/// The article's text: everything from its marker up to the next article's.
fn extract_article(html: &str, art_id: &str) -> Option<String> {
    let marker = format!("id=\"{art_id}\"");
    let pos = html.find(&marker)? + marker.len();
    let end = next_article_marker(html, pos).unwrap_or(html.len());
    let text = strip_markup(&html[pos..end]);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
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
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#160;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML: &str = r#"<html><body>
      <div class="eli-subdivision" id="rct_1"><p>Recital text.</p></div>
      <div class="eli-subdivision" id="art_1">
        <p class="oj-ti-art">Article 1</p>
        <p class="oj-sti-art">Subject-matter</p>
        <div class="eli-subdivision" id="art_1.001"><p>This Regulation lays down rules&nbsp;on protection.</p></div>
      </div>
      <div class="eli-subdivision" id="art_2">
        <p class="oj-ti-art">Article 2</p>
        <div class="norm"><p>This Regulation applies to processing.</p></div>
      </div>
    </body></html>"#;

    #[test]
    fn lists_articles_in_order_ignoring_recitals() {
        let norms: Vec<_> = article_ids(HTML).into_iter().map(to_legal_norm).collect();
        assert_eq!(norms.len(), 2);
        assert_eq!(norms[0].id, "art_1");
        assert_eq!(norms[0].label, "Article 1");
        assert_eq!(norms[1].id, "art_2");
    }

    #[test]
    fn extracts_article_text_up_to_the_next_article() {
        let t1 = extract_article(HTML, "art_1").unwrap();
        assert!(t1.contains("lays down rules on protection")); // &nbsp; normalised
        assert!(!t1.contains("applies to processing")); // stopped before art_2
        let t2 = extract_article(HTML, "art_2").unwrap();
        assert!(t2.contains("applies to processing"));
    }

    #[test]
    fn celex_is_sanitized_into_the_url() {
        assert_eq!(sanitize_celex("CELEX:../x"), "CELEXx");
        assert!(content_url("32016R0679").contains("TXT/HTML"));
    }
}
