# Cardo sync v1 — cross-language fixtures

Ground truth produced and verified by the Rust core (`crates/cardo-core`),
consumed by the TypeScript port (`packages/sync`, the iPhone PWA). Both sides
must pass every file here. If Rust behaviour changes, these fixtures change
with it, and the TS port has to follow.

Verified by `cargo test -p cardo-core` (`tests/sync_vectors.rs`,
`tests/conformance.rs`).

## Files

| File | Contents |
|---|---|
| `key.json` | One **fixed, public test key** (`CRD1-…`), plus `payloadHex` (33 B: version‖license 8 B‖secret 20 B‖check 4 B), `licenseId`, `secretHex`, `checkHex`, `authToken` (HKDF-SHA256, salt `cardo-sync-v1`, info `auth`) and `dataKeyHex` (info `data`). Never use it for real data. |
| `keys.json` | `valid[]`: `{input, note, licenseId, authToken}`. These are messy spellings of the fixed key (lowercase, spaces, surrounding whitespace, no separators, en dashes, mixed case) plus a second independent key. `invalid[]`: `{input, reason}` with `reason` ∈ `missing_prefix`, `invalid_chars`, `wrong_length`, `unsupported_version` (version 0x02 with a valid checksum), `checksum_mismatch` (single-character typo). The parser trims, uppercases (ASCII), drops every char outside `[A-Za-z0-9]`, requires the `CRD1` prefix and then checks in the order listed. |
| `xchacha-kat.json` | XChaCha20-Poly1305 vectors: the draft-irtf-cfrg-xchacha-03 §A.3.1 vector, and a Cardo vector (fixture data key, nonce `00..17`, AAD = op_id as UTF-8, plaintext = a serialized `SyncOp`). `sealedHex` = ciphertext‖tag. `blobHex`/`blobB64` = the wire blob `nonce(24)‖ciphertext‖tag`. |
| `notes-hash.json` | `files.notes` hashes: lowercase hex SHA-256 over the raw UTF-8 bytes of the content (no CRLF/Unicode normalization, BOM kept). Mirrors `content_hash()` in `apps/desktop/src-tauri/src/sync_files.rs`. A notes doc is `{content, hash}`. |
| `rust-hub/ops/*.cardo-ops` | A real folder hub written by `SqliteStorage` + `SyncEngine` + `FolderTransport` with the fixed key. It has 3 batch files, one per writer phase. Each file is `{"version":1,"ops":[{"op_id","blob_b64"}]}` and is named `<ms:013>-<uuidv4>.cardo-ops`. Pull order = filenames sorted, then ops in file order. The Google Drive hub uses the same file format. |
| `rust-hub/plaintext.json` | Every pushed `SyncOp` in push order (matches the hub order). Each blob decrypts to exactly `JSON.stringify`-equivalent serde output of the op: field order `op_id, device_id, hlc, namespace, doc_id, op, field, value, created_at`, with nested object keys sorted by byte order. Absent `field`/`value` are `null`. |
| `rust-hub/expected-docs.json` | `dump_all()` of the writer: `{namespace: {docId: doc}}` of live docs. A fresh store that pulls the hub must end up with exactly this. Every op must apply (single-writer history). Covers: several namespaces (`todo`, `contacts`, `files.notes`, `core`, `core.sync-control`), umlaut/emoji/dash doc ids, set_field/delete_field/delete_doc, re-create after delete, a doc created and deleted in one batch, the `core/sync-devices` registry, nested objects/arrays/null, negative ints, floats (`1.0`, `1.5e-7`, `-273.15`), `2^53-1`, escapes. |
| `conformance/*.json` | Declarative storage/LWW scenarios (below). |
| `wire-parse.json` | `[{name, text, ok, canonical?}]`: SyncOp plaintexts and whether `serde_json::from_str::<SyncOp>` accepts them (`tests/wire_parse.rs`). The TS decoder must accept exactly the same set: integer-only `created_at` within i64 (no `1.0`, `1e3`, `-0`), no duplicate known fields, no lone-surrogate escapes in decoded strings, finite numbers, nesting ≤ 127, unknown fields only syntax-checked, serde's 9-element sequence form. `canonical` = serde re-serialization. Refill with `CARDO_WRITE_VECTORS=1 cargo test -p cardo-core --test wire_parse`. |
| `ts-hub/` | The reverse direction: the same scripted writer sequence as `rust-hub/`, written by the **TypeScript port** (IndexedDB store + `SyncEngine` + folder hub). Same layout (`ops/`, `plaintext.json`, `expected-docs.json`). `tests/sync_interop.rs` checks that every blob is byte-identical to `serde_json::to_string` of the op, that every batch file is byte-identical to serde's `BatchFile`, and that a fresh `SqliteStorage` pulling it ends up equal to `expected-docs.json` (= `rust-hub/expected-docs.json` with `ratio: 1.0` → `1`, since JS has no integral floats). Regenerate from the repo root with `CARDO_WRITE_VECTORS=1 pnpm vitest run packages/sync -t "writes the ts-hub"`. |

## Conformance scenario format

```jsonc
{
  "name": "01-…", "description": "…",
  "steps": [
    { "kind": "set",    "namespace": "todo", "id": "t1", "value": {…},
      "expectOperation": "create" | "update", "expectOpsLogged": 1, "expectError": true? },
    { "kind": "delete", "namespace": "todo", "id": "t1", "expectOpsLogged": 1, "expectError": true? },
    { "kind": "get",    "namespace": "todo", "id": "t1", "expectDoc": {…} | null, "expectError": true? },
    { "kind": "remote", "op": { SyncOp wire shape },
      "expect": "applied" | "skipped" | "error", "expectOperation": "create" | "update" | "delete"? },
    { "kind": "query",  "namespace": "q", "query": { "where": [{field, op, value}], "orderBy"?, "direction"?, "limit"? },
      "expectRows": [ … ], "ordered": bool?, "expectError": true? },
    { "kind": "sleep",  "ms": 5 }
  ],
  "expectDocs": { dump_all() after all steps },
  "expectLocalOps": [ { "namespace", "docId", "op", "field", "value" } ]
}
```

* Each scenario starts with a fresh, empty store.
* `remote` calls `apply_remote_op`: `applied` = returned a change notice,
  `skipped` = duplicate or LWW loser, `error` = rejected (nothing recorded).
* Remote hlcs: `9999999999999-0000-remote` is always newer than any local
  write and `0000000000001-0000-remote` is always older. Values like
  `5000000000000-…` are newer than local writes but are ordered among
  themselves. HLCs compare as plain strings and the remote must be strictly
  greater.
* `query` rows compare as an ordered list when `orderBy` is set (or
  `ordered: true`). Otherwise they compare as a multiset. `expectRows` holds
  full document values.
* `expectLocalOps` is the device's own change log in write order (ids, hlc,
  timestamps ignored). Remote winners are logged too, but as already synced,
  so they are not part of it. Absent `field`/`value` are `null`.
* `sleep` waits (real time) so that later writes get a strictly greater
  `updated_at` – used where the scan order matters.
* `note` fields are informational.

Scenarios: 01 field op on deleted doc resurrects · 02 create vs field LWW
(older create loses to newer field op) · 03 exact tie loses / string hlc
order · 04 invalid field names / op kinds lose silently, error when they
would win; bad namespace/id always error · 05 delete_doc on missing doc is
applied · 06 local change-log rules (unchanged set logs nothing, set after
delete logs create, delete of missing logs nothing, diff order) · 07
duplicate op id skipped · 08 id byte limit (128 UTF-8 bytes) with umlauts
and namespace rules · 09 arrays / null values · 10 query semantics (LIKE
`%`/`_`/ASCII-only case folding, `!=` on missing/null, NULL ordering, `in`,
numbers vs text, booleans as 1/0, binary text order, invalid queries) · 11
remote winners feed later LWW · 12 query scan order (no ORDER BY →
`updated_at`, then rowid via idx_docs_ns_updated; ORDER BY is a stable sort
on top of it, also for DESC and with LIMIT) · 13 integral floats (`2.0`):
what both sides agree on; the known JS limitation is documented there.

The conformance JSON files are maintained by hand. When you add a scenario,
run `cargo test -p cardo-core --test conformance`. Rust is the reference: a
failing expectation means the fixture is wrong, unless the Rust behaviour is
a bug that is being fixed on purpose.

## Regenerating

All other files come from the `#[ignore]` tests in `tests/sync_vectors.rs`:

```sh
# Derived fixtures (keys.json, xchacha-kat.json, notes-hash.json, rust-hub/) from key.json:
CARDO_WRITE_VECTORS=1 cargo test -p cardo-core --test sync_vectors -- --ignored write_vectors

# New fixed key (rarely needed: it invalidates every derived file, so run write_vectors afterwards):
CARDO_WRITE_VECTORS=1 CARDO_FORCE_NEW_KEY=1 \
  cargo test -p cardo-core --test sync_vectors -- --ignored regenerate_key
```

The hub is rebuilt from scratch on every regeneration, so op ids, device id,
hlcs, nonces and file names change. Commit the whole `rust-hub/` folder
together.
