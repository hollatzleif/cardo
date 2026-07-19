//! Germany – gesetze-im-internet.de (official federal law, BMJ/juris).
//!
//! `gii-toc.xml` lists every federal law (title + link). Each law ships as a
//! zipped XML (`<abbr>/xml.zip`) whose `<norm>` elements carry the section
//! label (`<enbez>`, e.g. "§ 242"), an optional `<titel>` and the text under
//! `<textdaten>`. German statute text is a public work (§ 5 UrhG), so storing
//! and syncing it is unproblematic. Parsing is pure and fixture-tested; the
//! fetch methods just add the network + unzip around it.

use std::io::{Cursor, Read};

use super::{
    fetch_bytes, fetch_text, FetchedNorm, LegalBook, LegalNorm, LegalResult, LegalSource, SourceInfo,
};
use quick_xml::events::Event;
use quick_xml::Reader;

const HOST: &str = "www.gesetze-im-internet.de";
const TOC_URL: &str = "https://www.gesetze-im-internet.de/gii-toc.xml";

fn hosts() -> Vec<String> {
    vec![HOST.to_string()]
}

pub struct GesetzeImInternet;

#[async_trait::async_trait]
impl LegalSource for GesetzeImInternet {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "de".into(),
            name: "Deutschland (Bundesrecht)".into(),
            jurisdiction: "DE".into(),
            requires_key: false,
            hosts: hosts(),
        }
    }

    async fn list_books(&self) -> LegalResult<Vec<LegalBook>> {
        let xml = fetch_text(TOC_URL, &hosts()).await?;
        Ok(parse_toc(&xml))
    }

    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>> {
        let xml = fetch_law_xml(book).await?;
        Ok(parse_norms(&xml).into_iter().filter_map(to_legal_norm).collect())
    }

    async fn fetch_norm(&self, book: &str, norm: &str, _section: &str) -> LegalResult<FetchedNorm> {
        let xml = fetch_law_xml(book).await?;
        let found = parse_norms(&xml)
            .into_iter()
            .find(|n| n.enbez == norm)
            .ok_or_else(|| format!("section not found: {norm}"))?;
        Ok(FetchedNorm {
            text: found.text,
            stand: stand_from_builddate(&found.builddate),
            source_url: format!("https://www.gesetze-im-internet.de/{}/", sanitize_abbr(book)),
        })
    }
}

/// Only [a-z0-9_-]; the abbreviation becomes a URL path segment.
fn sanitize_abbr(book: &str) -> String {
    book.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

async fn fetch_law_xml(book: &str) -> LegalResult<String> {
    let abbr = sanitize_abbr(book);
    if abbr.is_empty() {
        return Err("empty law abbreviation".into());
    }
    let url = format!("https://www.gesetze-im-internet.de/{abbr}/xml.zip");
    let bytes = fetch_bytes(&url, &hosts()).await?;
    unzip_first_xml(&bytes)
}

fn unzip_first_xml(bytes: &[u8]) -> LegalResult<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        if file.name().to_lowercase().ends_with(".xml") {
            let mut out = String::new();
            file.read_to_string(&mut out).map_err(|e| e.to_string())?;
            return Ok(out);
        }
    }
    Err("no XML file in the law archive".into())
}

/* ── Pure parsers (fixture-tested) ────────────────────────────────────────── */

fn parse_toc(xml: &str) -> Vec<LegalBook> {
    let mut reader = Reader::from_str(xml);
    let mut books = Vec::new();
    let mut path: Vec<Vec<u8>> = Vec::new();
    let (mut title, mut link) = (String::new(), String::new());
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                if name == b"item" {
                    title.clear();
                    link.clear();
                }
                path.push(name);
            }
            Ok(Event::Text(t)) => {
                let s = t.unescape().map(|c| c.into_owned()).unwrap_or_default();
                let s = s.trim();
                if s.is_empty() {
                } else if path_has(&path, b"title") {
                    push_sp(&mut title, s);
                } else if path_has(&path, b"link") {
                    push_sp(&mut link, s);
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name().as_ref().to_vec();
                path.pop();
                if name == b"item" {
                    if let Some(id) = abbr_from_link(&link) {
                        if !title.is_empty() {
                            books.push(LegalBook { id, name: title.clone() });
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    books
}

fn abbr_from_link(link: &str) -> Option<String> {
    let trimmed = link.trim().trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    let last = *parts.last()?;
    // Each law's link points at a FILE inside the law's directory — the live TOC
    // uses `…/<abbr>/xml.zip` (older docs used `…/<abbr>/index.html`). When the
    // last segment is a file (has an extension), the abbreviation is the
    // directory above it; a bare `…/<abbr>` link has no file segment.
    let abbr = if last.contains('.') {
        parts.get(parts.len().checked_sub(2)?)?
    } else {
        &last
    };
    let clean = sanitize_abbr(abbr);
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

struct RawNorm {
    enbez: String,
    titel: String,
    text: String,
    builddate: String,
}

fn parse_norms(xml: &str) -> Vec<RawNorm> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut cur: Option<RawNorm> = None;
    let mut path: Vec<Vec<u8>> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                if name == b"norm" {
                    let builddate = e
                        .try_get_attribute("builddate")
                        .ok()
                        .flatten()
                        .and_then(|a| a.unescape_value().ok().map(|c| c.into_owned()))
                        .unwrap_or_default();
                    cur = Some(RawNorm {
                        enbez: String::new(),
                        titel: String::new(),
                        text: String::new(),
                        builddate,
                    });
                }
                path.push(name);
            }
            Ok(Event::Text(t)) => {
                if let Some(n) = cur.as_mut() {
                    let s = t.unescape().map(|c| c.into_owned()).unwrap_or_default();
                    let s = s.trim();
                    if s.is_empty() {
                    } else if path_has(&path, b"enbez") {
                        push_sp(&mut n.enbez, s);
                    } else if path_has(&path, b"titel") {
                        push_sp(&mut n.titel, s);
                    } else if path_has(&path, b"textdaten") {
                        push_sp(&mut n.text, s);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name().as_ref().to_vec();
                path.pop();
                if name == b"norm" {
                    if let Some(n) = cur.take() {
                        out.push(n);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out
}

/// A norm becomes a listable entry only if it has a section label (§ / Art).
fn to_legal_norm(n: RawNorm) -> Option<LegalNorm> {
    let enbez = n.enbez.trim().to_string();
    if enbez.is_empty() || !(enbez.starts_with('§') || enbez.starts_with("Art")) {
        return None;
    }
    let label = if n.titel.trim().is_empty() {
        enbez.clone()
    } else {
        format!("{} — {}", enbez, n.titel.trim())
    };
    Some(LegalNorm { id: enbez, label })
}

fn stand_from_builddate(bd: &str) -> String {
    if bd.len() >= 8 && bd[..8].chars().all(|c| c.is_ascii_digit()) {
        format!("{}-{}-{}", &bd[0..4], &bd[4..6], &bd[6..8])
    } else {
        String::new()
    }
}

fn path_has(path: &[Vec<u8>], tag: &[u8]) -> bool {
    path.iter().any(|p| p.as_slice() == tag)
}

fn push_sp(buf: &mut String, s: &str) {
    if !buf.is_empty() {
        buf.push(' ');
    }
    buf.push_str(s);
}

#[cfg(test)]
mod tests {
    use super::*;

    // The live TOC links point straight at each law's xml.zip; older docs used
    // index.html. Both must map to the bare abbreviation.
    const TOC: &str = r#"<?xml version="1.0"?>
<items>
  <item><title>Bürgerliches Gesetzbuch</title><link>http://www.gesetze-im-internet.de/bgb/xml.zip</link></item>
  <item><title>Grundgesetz</title><link>https://www.gesetze-im-internet.de/gg/index.html</link></item>
</items>"#;

    const LAW: &str = r#"<?xml version="1.0"?>
<dokumente>
  <norm builddate="20240315120000">
    <metadaten><jurabk>BGB</jurabk><titel>Bürgerliches Gesetzbuch</titel></metadaten>
  </norm>
  <norm builddate="20240315120000">
    <metadaten><enbez>§ 242</enbez><titel>Leistung nach Treu und Glauben</titel></metadaten>
    <textdaten><text><Content><P>Der Schuldner ist verpflichtet, die Leistung so zu bewirken, wie Treu und Glauben es erfordern.</P></Content></text></textdaten>
  </norm>
</dokumente>"#;

    #[test]
    fn parses_the_toc_into_books() {
        let books = parse_toc(TOC);
        assert_eq!(books.len(), 2);
        assert_eq!(books[0].id, "bgb");
        assert_eq!(books[0].name, "Bürgerliches Gesetzbuch");
        assert_eq!(books[1].id, "gg");
    }

    #[test]
    fn abbr_is_derived_from_the_link() {
        // Live format: the link ends in the law's xml.zip.
        assert_eq!(abbr_from_link("http://www.gesetze-im-internet.de/bgb/xml.zip").as_deref(), Some("bgb"));
        // Abbreviations can carry digits, hyphens and underscores (umlauts).
        assert_eq!(abbr_from_link("http://www.gesetze-im-internet.de/1-dm-goldm_nzg/xml.zip").as_deref(), Some("1-dm-goldm_nzg"));
        // Legacy format: index.html.
        assert_eq!(abbr_from_link("https://www.gesetze-im-internet.de/bgb/index.html").as_deref(), Some("bgb"));
        // Bare directory link.
        assert_eq!(abbr_from_link("https://www.gesetze-im-internet.de/gg/").as_deref(), Some("gg"));
        assert_eq!(abbr_from_link(""), None);
    }

    #[test]
    fn lists_only_sections_with_a_label() {
        let norms: Vec<_> = parse_norms(LAW).into_iter().filter_map(to_legal_norm).collect();
        // The first <norm> is the law header (no enbez) and is skipped.
        assert_eq!(norms.len(), 1);
        assert_eq!(norms[0].id, "§ 242");
        assert!(norms[0].label.contains("Treu und Glauben"));
    }

    #[test]
    fn extracts_the_section_text_and_stand() {
        let raw = parse_norms(LAW);
        let n = raw.iter().find(|n| n.enbez == "§ 242").unwrap();
        assert!(n.text.contains("Schuldner ist verpflichtet"));
        assert_eq!(stand_from_builddate(&n.builddate), "2024-03-15");
    }

    #[test]
    fn abbr_is_sanitized_against_path_tricks() {
        assert_eq!(sanitize_abbr("../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_abbr("BGB"), "bgb");
    }
}
