use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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

    pub fn now(&self) -> String {
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
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
}
