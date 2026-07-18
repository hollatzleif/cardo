//! United Kingdom – legislation.gov.uk (Crown Legislation Markup Language).
//!
//! An act is addressed as `<type>/<year>/<number>` (e.g. `ukpga/2018/12`); its
//! CLML XML is at `<act>/data.xml`. Sections are `<P1 id="section-1">` with a
//! `<Pnumber>`, a sibling `<Title>` (the heading, under `<P1group>`) and the
//! text under `<Text>`. UK legislation is Crown copyright, reusable under the
//! Open Government Licence. The parser is fixture-tested; legislation.gov.uk's
//! documented `/data.xml` makes the live fetch reliable.

use super::{fetch_text, FetchedNorm, LegalBook, LegalNorm, LegalResult, LegalSource, SourceInfo};
use quick_xml::events::Event;
use quick_xml::Reader;

fn hosts() -> Vec<String> {
    vec!["www.legislation.gov.uk".to_string()]
}

fn curated_books() -> Vec<LegalBook> {
    vec![
        LegalBook { id: "ukpga/2018/12".into(), name: "Data Protection Act 2018".into() },
        LegalBook { id: "ukpga/1998/42".into(), name: "Human Rights Act 1998".into() },
        LegalBook { id: "ukpga/2010/15".into(), name: "Equality Act 2010".into() },
    ]
}

/// Keep only [a-z0-9/]; the act id becomes a URL path (type/year/number).
fn sanitize_path(book: &str) -> String {
    book.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '/')
        .collect::<String>()
        .trim_matches('/')
        .to_string()
}

fn content_url(book: &str) -> String {
    format!("https://www.legislation.gov.uk/{}/data.xml", sanitize_path(book))
}

pub struct LegislationGovUk;

#[async_trait::async_trait]
impl LegalSource for LegislationGovUk {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "uk".into(),
            name: "United Kingdom (legislation.gov.uk)".into(),
            jurisdiction: "UK".into(),
            requires_key: false,
            hosts: hosts(),
        }
    }

    async fn list_books(&self) -> LegalResult<Vec<LegalBook>> {
        Ok(curated_books())
    }

    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>> {
        let xml = fetch_text(&content_url(book), &hosts()).await?;
        Ok(parse_sections(&xml).into_iter().map(to_legal_norm).collect())
    }

    async fn fetch_norm(&self, book: &str, norm: &str, _section: &str) -> LegalResult<FetchedNorm> {
        let url = content_url(book);
        let xml = fetch_text(&url, &hosts()).await?;
        let found = parse_sections(&xml)
            .into_iter()
            .find(|s| s.id == norm)
            .ok_or_else(|| format!("section not found: {norm}"))?;
        Ok(FetchedNorm { text: found.text, stand: String::new(), source_url: url })
    }
}

/* ── Pure parser (fixture-tested) ─────────────────────────────────────────── */

struct RawSection {
    id: String,
    pnumber: String,
    heading: String,
    text: String,
}

fn parse_sections(xml: &str) -> Vec<RawSection> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut cur: Option<RawSection> = None;
    let mut pending_title = String::new();
    let mut path: Vec<Vec<u8>> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                if name == b"P1group" {
                    pending_title.clear();
                } else if name == b"P1" {
                    let id = e
                        .try_get_attribute("id")
                        .ok()
                        .flatten()
                        .and_then(|a| a.unescape_value().ok().map(|c| c.into_owned()))
                        .unwrap_or_default();
                    cur = Some(RawSection {
                        id,
                        pnumber: String::new(),
                        heading: pending_title.trim().to_string(),
                        text: String::new(),
                    });
                }
                path.push(name);
            }
            Ok(Event::Text(t)) => {
                let s = t.unescape().map(|c| c.into_owned()).unwrap_or_default();
                let s = s.trim();
                if s.is_empty() {
                } else if direct_child_of(&path, b"P1group", b"Title") {
                    push_sp(&mut pending_title, s);
                } else if let Some(sec) = cur.as_mut() {
                    if direct_child_of(&path, b"P1", b"Pnumber") {
                        push_sp(&mut sec.pnumber, s);
                    } else if path_has(&path, b"Text") {
                        push_sp(&mut sec.text, s);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name().as_ref().to_vec();
                path.pop();
                if name == b"P1" {
                    if let Some(sec) = cur.take() {
                        out.push(sec);
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

fn to_legal_norm(s: RawSection) -> LegalNorm {
    let num = if s.pnumber.is_empty() { s.id.clone() } else { format!("s. {}", s.pnumber) };
    let label = if s.heading.is_empty() { num.clone() } else { format!("{} — {}", num, s.heading) };
    LegalNorm { id: s.id, label }
}

fn direct_child_of(path: &[Vec<u8>], parent: &[u8], child: &[u8]) -> bool {
    let n = path.len();
    n >= 2 && path[n - 1].as_slice() == child && path[n - 2].as_slice() == parent
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

    const CLML: &str = r#"<Legislation>
  <Primary><Body><Part>
    <P1group>
      <Title>Interpretation</Title>
      <P1 id="section-1">
        <Pnumber>1</Pnumber>
        <P1para><Text>In this Act, "personal data" has the meaning given in section 3.</Text></P1para>
      </P1>
    </P1group>
    <P1group>
      <Title>Territorial application</Title>
      <P1 id="section-2">
        <Pnumber>2</Pnumber>
        <P1para><Text>This Act applies to processing in the United Kingdom.</Text></P1para>
      </P1>
    </P1group>
  </Part></Body></Primary>
</Legislation>"#;

    #[test]
    fn parses_sections_with_id_number_and_heading() {
        let secs = parse_sections(CLML);
        assert_eq!(secs.len(), 2);
        assert_eq!(secs[0].id, "section-1");
        assert_eq!(secs[0].pnumber, "1");
        assert_eq!(secs[0].heading, "Interpretation");
        assert_eq!(secs[1].heading, "Territorial application");
    }

    #[test]
    fn extracts_section_text() {
        let secs = parse_sections(CLML);
        assert!(secs[0].text.contains("personal data"));
        assert!(!secs[0].text.contains("Interpretation")); // heading is not body text
    }

    #[test]
    fn label_uses_section_number_and_heading() {
        let norm = to_legal_norm(parse_sections(CLML).into_iter().next().unwrap());
        assert_eq!(norm.id, "section-1");
        assert_eq!(norm.label, "s. 1 — Interpretation");
    }

    #[test]
    fn path_is_sanitized() {
        assert_eq!(sanitize_path("ukpga/2018/12"), "ukpga/2018/12");
        assert_eq!(sanitize_path("../../etc"), "etc");
        assert_eq!(content_url("ukpga/2018/12"), "https://www.legislation.gov.uk/ukpga/2018/12/data.xml");
    }
}
