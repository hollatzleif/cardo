//! Look-back cursor for filename-ordered sync hubs.
//!
//! Every transport names its batch files `<uploader_ms:013>-<uuid>.cardo-ops`
//! and used to remember only the last filename it read. That loses files:
//! a device whose clock runs behind – or whose upload finished after a newer
//! file was already listed – produces a name that sorts BELOW the reader's
//! cursor and would never be read.
//!
//! `LookbackCursor` keeps the last name plus the set of names already read
//! inside a sliding window (`LOOKBACK_MS`) before it. A name is due when it
//! sorts after `last`, or when it falls inside the window and was not seen
//! yet. Each file is therefore read exactly once, as long as it shows up
//! within the window. Only local cursor state changes; the hub format does not.
//!
//! Stored form: a legacy plain filename (still accepted and migrated) or
//! compact JSON `{"last":"…","seen":["…",…]}` (struct field order, sorted set:
//! deterministic). The empty cursor renders as `""`.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// How far before `last` (by the filename's millisecond prefix) late files
/// are still picked up.
pub const LOOKBACK_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LookbackCursor {
    /// Greatest filename processed so far.
    pub last: String,
    /// Names already processed that lie inside the look-back window.
    #[serde(default)]
    pub seen: BTreeSet<String>,
}

/// Millisecond prefix of a batch filename (`<ms:013>-…`).
pub fn name_ms(name: &str) -> Option<u64> {
    let prefix = name.split('-').next()?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    prefix.parse().ok()
}

impl LookbackCursor {
    /// Parses a stored cursor. A legacy plain filename becomes
    /// `{last: name, seen: {}}` (the first pull after migration re-reads the
    /// window once – harmless, the engine dedupes by op id, and it recovers
    /// files the old cursor skipped). Unparsable JSON falls back to the empty
    /// cursor: a full re-pull, never an error.
    pub fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw.is_empty() {
            return Self::default();
        }
        if raw.starts_with('{') {
            if let Ok(cursor) = serde_json::from_str::<LookbackCursor>(raw) {
                return cursor;
            }
            return Self::default();
        }
        Self { last: raw.to_string(), seen: BTreeSet::new() }
    }

    /// Deterministic storage form.
    pub fn render(&self) -> String {
        if self.last.is_empty() && self.seen.is_empty() {
            return String::new();
        }
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Lower bound (inclusive, in ms) of the look-back window, if `last`
    /// carries a parsable timestamp.
    fn window_floor(&self) -> Option<u64> {
        name_ms(&self.last).map(|ms| ms.saturating_sub(LOOKBACK_MS))
    }

    /// Whether `name` is due for reading.
    pub fn is_due(&self, name: &str) -> bool {
        if name > self.last.as_str() {
            return true;
        }
        if name == self.last || self.seen.contains(name) {
            return false;
        }
        match (self.window_floor(), name_ms(name)) {
            (Some(floor), Some(ms)) => ms >= floor,
            _ => false,
        }
    }

    /// Names (from an ascending-sorted list) due for reading, oldest first,
    /// at most `take` of them.
    pub fn select<S: AsRef<str>>(&self, names_sorted: &[S], take: usize) -> Vec<String> {
        names_sorted
            .iter()
            .map(AsRef::as_ref)
            .filter(|name| self.is_due(name))
            .take(take)
            .map(str::to_string)
            .collect()
    }

    /// Records processed names: `last` moves to the max, `seen` keeps only
    /// names still inside the window.
    pub fn advance<S: AsRef<str>>(&mut self, processed: &[S]) {
        // `last` itself was processed too (a migrated legacy cursor has it
        // outside `seen`); keep it from becoming due once `last` moves on.
        if !self.last.is_empty() {
            self.seen.insert(self.last.clone());
        }
        for name in processed {
            let name = name.as_ref();
            if name > self.last.as_str() {
                self.last = name.to_string();
            }
            self.seen.insert(name.to_string());
        }
        match self.window_floor() {
            Some(floor) => self
                .seen
                .retain(|name| name_ms(name).is_some_and(|ms| ms >= floor)),
            None => self.seen.clear(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(ms: u64, tag: &str) -> String {
        format!("{ms:013}-{tag}.cardo-ops")
    }

    #[test]
    fn legacy_plain_cursor_migrates() {
        let legacy = name(1_700_000_000_000, "a");
        let c = LookbackCursor::parse(&legacy);
        assert_eq!(c.last, legacy);
        assert!(c.seen.is_empty());
        // Re-rendered as the new deterministic format and parsed back.
        let rendered = c.render();
        assert!(rendered.starts_with('{'));
        assert_eq!(LookbackCursor::parse(&rendered), c);
    }

    #[test]
    fn empty_roundtrips_as_empty() {
        assert_eq!(LookbackCursor::parse("").render(), "");
        assert_eq!(LookbackCursor::default().render(), "");
    }

    #[test]
    fn render_is_deterministic() {
        let mut a = LookbackCursor::default();
        a.advance(&[name(1_000_000, "b"), name(999_000, "a")]);
        let mut b = LookbackCursor::default();
        b.advance(&[name(999_000, "a"), name(1_000_000, "b")]);
        assert_eq!(a.render(), b.render());
        assert_eq!(LookbackCursor::parse(&a.render()), a);
    }

    #[test]
    fn late_file_inside_window_is_selected_once() {
        let base = 1_700_000_000_000;
        let mut c = LookbackCursor::default();
        c.advance(&[name(base, "x")]);

        let late = name(base - 5_000, "late");
        let ancient = name(base - LOOKBACK_MS - 1, "ancient");
        let newer = name(base + 1, "new");
        let mut all = vec![late.clone(), ancient.clone(), name(base, "x"), newer.clone()];
        all.sort();

        let due = c.select(&all, 50);
        assert_eq!(due, vec![late.clone(), newer.clone()]);
        c.advance(&due);
        assert!(c.select(&all, 50).is_empty(), "nothing is read twice");
        assert_eq!(c.last, newer);
    }

    #[test]
    fn seen_is_trimmed_to_window() {
        let base = 1_700_000_000_000;
        let mut c = LookbackCursor::default();
        c.advance(&[name(base, "a")]);
        c.advance(&[name(base + LOOKBACK_MS + 1, "b")]);
        assert!(!c.seen.contains(&name(base, "a")));
        assert!(c.seen.contains(&name(base + LOOKBACK_MS + 1, "b")));
        // The trimmed name is outside the window, so it never becomes due.
        assert!(!c.is_due(&name(base, "a")));
    }

    #[test]
    fn take_limits_and_keeps_order() {
        let mut c = LookbackCursor::default();
        let names: Vec<String> = (0..5).map(|i| name(1_000_000 + i, "n")).collect();
        let first = c.select(&names, 2);
        assert_eq!(first, names[..2].to_vec());
        c.advance(&first);
        let rest = c.select(&names, 50);
        assert_eq!(rest, names[2..].to_vec());
    }
}
