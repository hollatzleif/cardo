use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Remote hlcs further ahead of the local wall clock are not observed.
pub const MAX_DRIFT_MS: u64 = 24 * 60 * 60 * 1000;

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `(<ms>, <counter>)` of `<ms:013>-<counter:04>-…`.
fn parse(hlc: &str) -> Option<(u64, u32)> {
    let b = hlc.as_bytes();
    if b.len() < 19 || b[13] != b'-' || b[18] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r.clone()].iter().all(u8::is_ascii_digit).then(|| &hlc[r]);
    Some((digits(0..13)?.parse().ok()?, digits(14..18)?.parse().ok()?))
}

/// Hybrid Logical Clock.
///
/// Produces strictly monotonic, lexically sortable timestamps of the form
/// `<unix_ms:013>-<counter:04>-<device_id>` even if the wall clock jumps
/// backwards. This is the ordering basis for last-writer-wins per field –
/// deterministic from day one, long before sync exists.
pub struct Hlc {
    device_id: String,
    state: Mutex<HlcState>,
}

struct HlcState {
    last_ms: u64,
    counter: u32,
}

impl Hlc {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self {
            device_id: device_id.into(),
            state: Mutex::new(HlcState { last_ms: 0, counter: 0 }),
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// HLC receive rule: after seeing `remote`, every later `now()` sorts
    /// after it. Remote clocks more than `MAX_DRIFT_MS` ahead of the local
    /// wall clock are ignored, so one device with a wildly wrong clock (or a
    /// forged op) cannot drag this clock into the far future. Mirrors
    /// `observeHlc` in packages/sync/src/hlc.ts.
    pub fn observe(&self, remote: &str) {
        let Some((ms, counter)) = parse(remote) else { return };
        if ms > wall_ms().saturating_add(MAX_DRIFT_MS) {
            return;
        }
        let mut s = self.state.lock().expect("hlc lock poisoned");
        if (ms, counter) > (s.last_ms, s.counter) {
            s.last_ms = ms;
            s.counter = counter;
        }
    }

    pub fn now(&self) -> String {
        let wall_ms = wall_ms();
        let mut s = self.state.lock().expect("hlc lock poisoned");
        if wall_ms > s.last_ms {
            s.last_ms = wall_ms;
            s.counter = 0;
        } else {
            // Wall clock stalled or went backwards: logical part keeps us monotonic.
            s.counter += 1;
            if s.counter > 9999 {
                s.last_ms += 1;
                s.counter = 0;
            }
        }
        format!("{:013}-{:04}-{}", s.last_ms, s.counter, self.device_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_strictly_increasing() {
        let hlc = Hlc::new("dev-a");
        let mut prev = hlc.now();
        for _ in 0..10_000 {
            let next = hlc.now();
            assert!(next > prev, "{next} should sort after {prev}");
            prev = next;
        }
    }

    #[test]
    fn observe_moves_past_a_remote_clock_within_the_drift_cap() {
        let hlc = Hlc::new("dev-a");
        let ahead = format!("{:013}-0042-dev-b", wall_ms() + 60_000);
        hlc.observe(&ahead);
        assert!(hlc.now() > ahead);
        let far = format!("{:013}-0000-dev-b", wall_ms() + 2 * MAX_DRIFT_MS);
        hlc.observe(&far);
        assert!(hlc.now() < far);
        hlc.observe("garbage");
        hlc.observe("0000000000001-0000-old");
    }
}
