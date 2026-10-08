//! Subscribed calendars: fetches a Google Calendar "secret address in iCal
//! format" for the calendar tool. Lives in Rust because Google serves the
//! .ics without CORS headers (the webview could not read it) and so the
//! allow-list is enforced outside the webview: only
//! `https://calendar.google.com/calendar/ical/…​.ics`, no redirects, size-capped.

use std::time::Duration;

const HOST: &str = "calendar.google.com";
const PATH_PREFIX: &str = "/calendar/ical/";
/// A busy calendar with years of history is a few MB at most.
const MAX_BYTES: usize = 10 * 1024 * 1024;

/// Only Google's secret iCal addresses: https, exact host, no userinfo/port.
pub fn ics_url_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return false,
    };
    let path_only = path.split(['?', '#']).next().unwrap_or("");
    authority == HOST
        && path_only.starts_with(PATH_PREFIX)
        && path_only.ends_with(".ics")
        && !path_only.contains("..")
}

#[tauri::command]
pub async fn calendar_fetch_ics(url: String) -> Result<String, String> {
    if !ics_url_allowed(&url) {
        return Err("only Google Calendar secret iCal addresses (https://calendar.google.com/calendar/ical/….ics) are allowed".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        // A redirect could lead anywhere; the allow-list covers one URL only.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Cardo (calendar subscription)")
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(&url).send().await.map_err(|e| format!("unreachable: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => "Google kennt diese Kalender-Adresse nicht (mehr) – wurde sie zurückgesetzt?".into(),
            401 | 403 => "Google verweigert den Zugriff auf diese Kalender-Adresse.".into(),
            code => format!("HTTP {code}"),
        });
    }
    if response.content_length().is_some_and(|len| len as usize > MAX_BYTES) {
        return Err("calendar too large".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("calendar too large".into());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("not an iCalendar file".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_google_secret_ics_urls() {
        assert!(ics_url_allowed(
            "https://calendar.google.com/calendar/ical/heike%40gmail.com/private-abc/basic.ics"
        ));
        assert!(!ics_url_allowed("http://calendar.google.com/calendar/ical/x/basic.ics"));
        assert!(!ics_url_allowed("https://calendar.google.com.evil.io/calendar/ical/x/basic.ics"));
        assert!(!ics_url_allowed("https://user@calendar.google.com/calendar/ical/x/basic.ics"));
        assert!(!ics_url_allowed("https://calendar.google.com:444/calendar/ical/x/basic.ics"));
        assert!(!ics_url_allowed("https://calendar.google.com/calendar/embed?src=x.ics"));
        assert!(!ics_url_allowed("https://calendar.google.com/calendar/ical/../../x.ics"));
        assert!(!ics_url_allowed("https://calendar.google.com"));
    }
}
