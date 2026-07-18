//! France – Légifrance via the PISTE API gateway (api.piste.gouv.fr).
//!
//! Special case: PISTE requires OAuth2 client-credentials the USER registers
//! (a shared secret in a public app is not tenable), so this source is marked
//! `requires_key` and reads the credentials from the OS keychain. Without a key
//! the codes are still listed, but fetching returns a clear "key required"
//! error. The Légifrance responses are JSON; the parser is fixture-tested, the
//! live OAuth + POST calls are best-effort.

use super::{
    host_allowed, piste_key, FetchedNorm, LegalBook, LegalNorm, LegalResult, LegalSource, SourceInfo,
};
use serde_json::Value;

const OAUTH_URL: &str = "https://oauth.piste.gouv.fr/api/oauth/token";
const API_BASE: &str = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";

fn hosts() -> Vec<String> {
    vec!["oauth.piste.gouv.fr".to_string(), "api.piste.gouv.fr".to_string()]
}

fn curated_books() -> Vec<LegalBook> {
    vec![
        LegalBook { id: "LEGITEXT000006070721".into(), name: "Code civil".into() },
        LegalBook { id: "LEGITEXT000006070719".into(), name: "Code pénal".into() },
        LegalBook { id: "LEGITEXT000006072050".into(), name: "Code du travail".into() },
    ]
}

fn sanitize_id(book: &str) -> String {
    book.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

pub struct Legifrance;

#[async_trait::async_trait]
impl LegalSource for Legifrance {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "fr".into(),
            name: "Frankreich (Légifrance)".into(),
            jurisdiction: "FR".into(),
            requires_key: true,
            hosts: hosts(),
        }
    }

    async fn list_books(&self) -> LegalResult<Vec<LegalBook>> {
        Ok(curated_books())
    }

    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>> {
        let json = fetch_code_json(book).await?;
        Ok(parse_articles(&json).into_iter().map(to_legal_norm).collect())
    }

    async fn fetch_norm(&self, book: &str, norm: &str, _section: &str) -> LegalResult<FetchedNorm> {
        let json = fetch_code_json(book).await?;
        let found = parse_articles(&json)
            .into_iter()
            .find(|a| a.id == norm || a.num == norm)
            .ok_or_else(|| format!("article not found: {norm}"))?;
        Ok(FetchedNorm {
            text: strip_markup(&found.texte),
            stand: String::new(),
            source_url: format!("https://www.legifrance.gouv.fr/codes/article_lc/{}", sanitize_id(&found.id)),
        })
    }
}

/// Acquire an access token, then POST the code request. Best-effort against the
/// live PISTE gateway; requires a user-supplied key.
async fn fetch_code_json(book: &str) -> LegalResult<String> {
    let (client_id, client_secret) =
        piste_key().ok_or("PISTE key required — add your Légifrance API credentials in settings")?;
    let token = piste_token(&client_id, &client_secret).await?;

    let url = format!("{API_BASE}/consult/legiPart");
    if !host_allowed(&url, &hosts()) {
        return Err(format!("host not allowed: {url}"));
    }
    let body = serde_json::json!({ "textId": sanitize_id(book), "date": consult_date() });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

async fn piste_token(client_id: &str, client_secret: &str) -> LegalResult<String> {
    if !host_allowed(OAUTH_URL, &hosts()) {
        return Err("oauth host not allowed".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(OAUTH_URL)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("scope", "openid"),
        ])
        .send()
        .await
        .map_err(|e| format!("token unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("token HTTP {}", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("access_token")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .ok_or_else(|| "no access_token in PISTE response".into())
}

/// Légifrance wants a consultation date; an empty value lets the API default
/// to the current version (the frontend can pass an explicit date later).
fn consult_date() -> String {
    String::new()
}

/* ── Pure JSON parser (fixture-tested) ────────────────────────────────────── */

struct RawArticle {
    id: String,
    num: String,
    texte: String,
}

fn parse_articles(json: &str) -> Vec<RawArticle> {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let mut out = Vec::new();
    collect_articles(&v, &mut out);
    out
}

/// Légifrance nests articles under sections; walk the tree and pick up any
/// object that looks like an article (has a `num` and a text field).
fn collect_articles(v: &Value, out: &mut Vec<RawArticle>) {
    match v {
        Value::Object(map) => {
            let num = map.get("num").and_then(|n| n.as_str());
            let texte = map
                .get("texte")
                .or_else(|| map.get("content"))
                .or_else(|| map.get("contenu"))
                .and_then(|t| t.as_str());
            if let (Some(num), Some(texte)) = (num, texte) {
                let id = map.get("id").and_then(|i| i.as_str()).unwrap_or(num).to_string();
                out.push(RawArticle { id, num: num.to_string(), texte: texte.to_string() });
            }
            for val in map.values() {
                collect_articles(val, out);
            }
        }
        Value::Array(arr) => {
            for val in arr {
                collect_articles(val, out);
            }
        }
        _ => {}
    }
}

fn to_legal_norm(a: RawArticle) -> LegalNorm {
    LegalNorm { id: if a.id.is_empty() { a.num.clone() } else { a.id }, label: format!("Art. {}", a.num) }
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

    const FR: &str = r#"{
      "sections": [
        { "title": "Titre préliminaire", "articles": [
          { "id": "LEGIARTI000006419280", "num": "1", "texte": "<p>La loi est promulguée par le Président.</p>" }
        ]},
        { "title": "Chapitre 1", "articles": [
          { "id": "LEGIARTI000006419281", "num": "2", "contenu": "La loi ne dispose que pour l'avenir." }
        ]}
      ]
    }"#;

    #[test]
    fn collects_articles_from_nested_sections() {
        let arts = parse_articles(FR);
        assert_eq!(arts.len(), 2);
        assert_eq!(arts[0].num, "1");
        assert_eq!(arts[0].id, "LEGIARTI000006419280");
        assert_eq!(arts[1].num, "2");
    }

    #[test]
    fn label_and_markup_strip() {
        let norm = to_legal_norm(parse_articles(FR).into_iter().next().unwrap());
        assert_eq!(norm.label, "Art. 1");
        assert_eq!(strip_markup("<p>La loi est <b>promulguée</b>.</p>"), "La loi est promulguée.");
    }

    #[test]
    fn source_is_marked_as_requiring_a_key() {
        assert!(Legifrance.info().requires_key);
    }

    #[test]
    fn id_is_sanitized() {
        assert_eq!(sanitize_id("LEGITEXT000006070721"), "LEGITEXT000006070721");
        assert_eq!(sanitize_id("../evil"), "evil");
    }
}
