//! `wire-parse.json`: which SyncOp plaintexts serde_json accepts. The
//! TypeScript port (`packages/sync/src/wire.ts`) must accept exactly the same
//! set, or one device applies an op the other drops. `canonical` is
//! `serde_json::to_string` of the parsed op (re-serialization must match it).
//!
//! Refill `canonical` after editing the vectors:
//! `CARDO_WRITE_VECTORS=1 cargo test -p cardo-core --test wire_parse`

mod common;

use cardo_core::SyncOp;
use common::{read_json, write_json, writing_enabled};
use serde_json::Value;

#[test]
fn serde_accepts_exactly_the_ok_vectors() {
    let mut vectors = read_json("wire-parse.json");
    let mut failures = Vec::new();
    for v in vectors.as_array_mut().expect("array") {
        let name = v["name"].as_str().unwrap().to_string();
        let text = v["text"].as_str().unwrap().to_string();
        let want_ok = v["ok"].as_bool().unwrap();
        let parsed = serde_json::from_str::<SyncOp>(&text);
        if parsed.is_ok() != want_ok {
            failures.push(format!("{name}: serde ok={} ({:?})", parsed.is_ok(), parsed.err()));
            continue;
        }
        let canonical = parsed.ok().map(|op| serde_json::to_string(&op).unwrap());
        if writing_enabled() {
            match canonical {
                Some(c) => v["canonical"] = Value::String(c),
                None => {
                    v.as_object_mut().unwrap().remove("canonical");
                }
            }
        } else if v["canonical"].as_str().map(str::to_string) != canonical {
            failures.push(format!("{name}: canonical {canonical:?} != {}", v["canonical"]));
        }
    }
    if writing_enabled() {
        write_json("wire-parse.json", &vectors);
    }
    assert!(failures.is_empty(), "wire-parse mismatches:\n{}", failures.join("\n"));
}
