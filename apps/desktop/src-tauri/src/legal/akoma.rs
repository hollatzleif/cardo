//! Shared Akoma Ntoso article parser, used by the EU (EUR-Lex) and CH (Fedlex)
//! adapters — both serve statute text in this format. `<article eId="art_1">`
//! carries a `<num>`, a `<heading>` and the body text under `<content>`; the
//! article-level `<num>` is kept distinct from a paragraph's own `<num>`.

use super::LegalNorm;
use quick_xml::events::Event;
use quick_xml::Reader;

pub(crate) struct Article {
    pub e_id: String,
    pub num: String,
    pub heading: String,
    pub text: String,
}

pub(crate) fn parse_articles(xml: &str) -> Vec<Article> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut cur: Option<Article> = None;
    let mut path: Vec<Vec<u8>> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                if name == b"article" {
                    let e_id = e
                        .try_get_attribute("eId")
                        .ok()
                        .flatten()
                        .and_then(|a| a.unescape_value().ok().map(|c| c.into_owned()))
                        .unwrap_or_default();
                    cur = Some(Article {
                        e_id,
                        num: String::new(),
                        heading: String::new(),
                        text: String::new(),
                    });
                }
                path.push(name);
            }
            Ok(Event::Text(t)) => {
                if let Some(a) = cur.as_mut() {
                    let s = t.unescape().map(|c| c.into_owned()).unwrap_or_default();
                    let s = s.trim();
                    if s.is_empty() {
                    } else if direct_child_of(&path, b"article", b"num") {
                        push_sp(&mut a.num, s);
                    } else if direct_child_of(&path, b"article", b"heading") {
                        push_sp(&mut a.heading, s);
                    } else if path_has(&path, b"content") {
                        push_sp(&mut a.text, s);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name().as_ref().to_vec();
                path.pop();
                if name == b"article" {
                    if let Some(a) = cur.take() {
                        out.push(a);
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

pub(crate) fn to_legal_norm(a: Article) -> LegalNorm {
    let num = if a.num.is_empty() { a.e_id.clone() } else { a.num.clone() };
    let label = if a.heading.is_empty() { num.clone() } else { format!("{} — {}", num, a.heading) };
    LegalNorm { id: a.e_id, label }
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

    const AKN: &str = r#"<akomaNtoso>
  <act><body>
    <article eId="art_1">
      <num>Article 1</num>
      <heading>Subject-matter and objectives</heading>
      <paragraph eId="art_1__para_1"><num>1.</num><content><p>This Regulation lays down rules relating to the protection of natural persons.</p></content></paragraph>
    </article>
    <article eId="art_2">
      <num>Art. 2</num>
      <heading>Material scope</heading>
      <paragraph eId="art_2__para_1"><content><p>This Regulation applies to the processing of personal data.</p></content></paragraph>
    </article>
  </body></act>
</akomaNtoso>"#;

    #[test]
    fn parses_article_num_heading_and_body() {
        let arts = parse_articles(AKN);
        assert_eq!(arts.len(), 2);
        assert_eq!(arts[0].e_id, "art_1");
        assert_eq!(arts[0].num, "Article 1"); // article num, not the paragraph "1."
        assert_eq!(arts[0].heading, "Subject-matter and objectives");
        assert!(arts[0].text.contains("protection of natural persons"));
        assert!(!arts[0].text.contains("Article 1"));
    }

    #[test]
    fn to_legal_norm_labels_by_num_and_heading() {
        let norm = to_legal_norm(parse_articles(AKN).into_iter().next().unwrap());
        assert_eq!(norm.id, "art_1");
        assert_eq!(norm.label, "Article 1 — Subject-matter and objectives");
    }
}
