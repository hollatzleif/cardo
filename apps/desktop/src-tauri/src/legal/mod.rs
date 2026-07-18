//! Legal-source adapters for the paragraphs tool. Each jurisdiction is a
//! [`LegalSource`] that lists statute books, lists a book's norms and fetches a
//! norm's official text — only ever from its own declared, allow-listed hosts.
//! The host guard is a hard gate (unit-tested): a URL outside the source's
//! declared hosts, or one that isn't a plain `https://host/…`, is refused
//! before any request goes out. Concrete adapters (de, eu, uk, …) are added
//! per jurisdiction in later steps.

use serde::Serialize;

mod at;
mod de;
mod eu;
mod uk;
// Not compiled (kept on disk for later):
//  - ch (Fedlex): a client-rendered SPA with no server-parseable content.
//  - akoma: the shared Akoma Ntoso parser ch used.
//  - fr (Légifrance/PISTE): usable only with a user PISTE key + a key-entry UI
//    that does not exist yet; shown as a dead option otherwise.

pub type LegalResult<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub jurisdiction: String,
    /// Needs a user-supplied API key before it can be used (e.g. FR / PISTE).
    pub requires_key: bool,
    /// Every host this source is allowed to contact.
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalBook {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalNorm {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedNorm {
    pub text: String,
    /// Date the text is current as of (yyyy-mm-dd, or empty if unknown).
    pub stand: String,
    pub source_url: String,
}

#[async_trait::async_trait]
pub trait LegalSource: Send + Sync {
    fn info(&self) -> SourceInfo;
    async fn list_books(&self) -> LegalResult<Vec<LegalBook>>;
    async fn list_norms(&self, book: &str) -> LegalResult<Vec<LegalNorm>>;
    async fn fetch_norm(&self, book: &str, norm: &str, section: &str) -> LegalResult<FetchedNorm>;
}

/// All registered adapters. One per jurisdiction; more are added per step.
pub fn sources() -> Vec<Box<dyn LegalSource>> {
    vec![
        Box::new(de::GesetzeImInternet),
        Box::new(eu::EurLex),
        Box::new(uk::LegislationGovUk),
        Box::new(at::Ris),
    ]
}

pub fn find_source(id: &str) -> Option<Box<dyn LegalSource>> {
    sources().into_iter().find(|s| s.info().id == id)
}

/// Union of every source's allow-listed hosts (sorted, deduped).
pub fn all_allowed_hosts() -> Vec<String> {
    let mut hosts: Vec<String> = sources().into_iter().flat_map(|s| s.info().hosts).collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

/// A URL may be fetched only if it is a plain `https://<host>/…` whose host is
/// in the allow-list (no scheme other than https, no userinfo, no port).
pub fn host_allowed(url: &str, hosts: &[String]) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || authority.contains(':') {
        return false;
    }
    hosts.iter().any(|h| authority == h)
}

/// GET an allow-listed URL and return its body text. Refuses non-allow-listed
/// hosts before opening a connection. Shared by the per-jurisdiction adapters.
pub async fn fetch_text(url: &str, hosts: &[String]) -> LegalResult<String> {
    if !host_allowed(url, hosts) {
        return Err(format!("host not allowed for a legal fetch: {url}"));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Cardo/1.1 (legal paragraphs)")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Like [`fetch_text`] but returns raw bytes (for zipped law archives).
pub async fn fetch_bytes(url: &str, hosts: &[String]) -> LegalResult<Vec<u8>> {
    if !host_allowed(url, hosts) {
        return Err(format!("host not allowed for a legal fetch: {url}"));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Cardo/1.1 (legal paragraphs)")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    Ok(resp.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/* ── FR / PISTE key (in the OS keychain, never in synced storage) ─────────── */

const PISTE_SERVICE: &str = "de.cardo.legal";
const PISTE_ENTRY: &str = "piste-key";

#[tauri::command]
pub async fn legal_set_piste_key(client_id: String, client_secret: String) -> LegalResult<()> {
    keyring::Entry::new(PISTE_SERVICE, PISTE_ENTRY)
        .map_err(|e| e.to_string())?
        .set_password(&format!("{client_id}\x1f{client_secret}"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn legal_piste_key_present() -> bool {
    matches!(
        keyring::Entry::new(PISTE_SERVICE, PISTE_ENTRY).map(|e| e.get_password()),
        Ok(Ok(_))
    )
}

#[tauri::command]
pub async fn legal_clear_piste_key() -> LegalResult<()> {
    let entry = keyring::Entry::new(PISTE_SERVICE, PISTE_ENTRY).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ── Tauri commands ───────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn legal_sources() -> Vec<SourceInfo> {
    sources().iter().map(|s| s.info()).collect()
}

/// Every host any legal adapter is allowed to contact – the diagnose
/// `security:legal-hosts` check verifies these stay a small, well-formed set.
#[tauri::command]
pub async fn legal_allowed_hosts() -> Vec<String> {
    all_allowed_hosts()
}

#[tauri::command]
pub async fn legal_list_books(source_id: String) -> LegalResult<Vec<LegalBook>> {
    find_source(&source_id)
        .ok_or_else(|| format!("unknown legal source: {source_id}"))?
        .list_books()
        .await
}

#[tauri::command]
pub async fn legal_list_norms(source_id: String, book: String) -> LegalResult<Vec<LegalNorm>> {
    find_source(&source_id)
        .ok_or_else(|| format!("unknown legal source: {source_id}"))?
        .list_norms(&book)
        .await
}

#[tauri::command]
pub async fn legal_fetch_norm(
    source_id: String,
    book: String,
    norm: String,
    section: String,
) -> LegalResult<FetchedNorm> {
    find_source(&source_id)
        .ok_or_else(|| format!("unknown legal source: {source_id}"))?
        .fetch_norm(&book, &norm, &section)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_guard_only_allows_declared_https_hosts() {
        let hosts = vec!["www.gesetze-im-internet.de".to_string()];
        assert!(host_allowed("https://www.gesetze-im-internet.de/bgb/__242.html", &hosts));
        assert!(!host_allowed("https://evil.example/x", &hosts));
        assert!(!host_allowed("http://www.gesetze-im-internet.de/x", &hosts), "not https");
        assert!(!host_allowed("https://www.gesetze-im-internet.de:8443/x", &hosts), "port");
        assert!(!host_allowed("https://u@www.gesetze-im-internet.de/x", &hosts), "userinfo");
        assert!(!host_allowed("ftp://www.gesetze-im-internet.de/x", &hosts), "scheme");
    }

    #[test]
    fn registry_source_ids_are_unique() {
        let ids: Vec<String> = sources().into_iter().map(|s| s.info().id).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len(), "duplicate legal source id");
    }
}
