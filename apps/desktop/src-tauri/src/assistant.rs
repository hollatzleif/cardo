//! Local LLM assistant engine: GGUF models via llama.cpp, fully offline.
//! Models are downloaded from HuggingFace on user request into
//! <app_data_dir>/models/ and loaded on demand into one of three slots
//! ("main" | "router" | "sub"). Generation runs on a blocking thread;
//! a tokio mutex per slot serialises access (one generation at a time
//! per slot – a concurrent caller gets Err("busy")).

use std::collections::HashSet;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

/// The standard llama.cpp JSON grammar (json.gbnf) – used to constrain
/// output to valid JSON when `json_only` is requested.
/// Schema-exact grammar for assistant replies: even the smallest models
/// are FORCED into the proposal contract (generic JSON alone lets weak
/// models produce structurally valid garbage – found by the live test).
const PROPOSAL_GRAMMAR: &str = r#"root ::= "{" ws "\"reply\"" ws ":" ws string ws "," ws "\"proposals\"" ws ":" ws proposals optdelegate optforget ws "," ws "\"memory\"" ws ":" ws stringarr ws "}"
optdelegate ::= (ws "," ws "\"delegate\"" ws ":" ws delegates)?
optforget ::= (ws "," ws "\"forget\"" ws ":" ws stringarr)?
proposals ::= "[" ws "]" | "[" ws proposal (ws "," ws proposal)* ws "]"
proposal ::= "{" ws "\"command\"" ws ":" ws string ws "," ws "\"params\"" ws ":" ws object ws "," ws "\"summary\"" ws ":" ws string ws "}"
delegates ::= "[" ws "]" | "[" ws delegate (ws "," ws delegate)* ws "]"
delegate ::= "{" ws "\"to\"" ws ":" ws string ws "," ws "\"reason\"" ws ":" ws string ws "}"
stringarr ::= "[" ws "]" | "[" ws string (ws "," ws string)* ws "]"
value ::= object | array | string | number | ("true" | "false" | "null")
object ::= "{" ws ( string ws ":" ws value (ws "," ws string ws ":" ws value)* )? ws "}"
array ::= "[" ws ( value (ws "," ws value)* )? ws "]"
string ::= "\"" ( [^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]) )* "\""
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
ws ::= [ \t\n]?
"#;

const SLOT_NAMES: [&str; 3] = ["main", "router", "sub"];
const PROGRESS_EVENT: &str = "assistant:download-progress";
const PROGRESS_EVERY_BYTES: u64 = 2 * 1024 * 1024;

/* ── State ────────────────────────────────────────────────────────────── */

struct LoadedModel {
    id: String,
    model: Arc<LlamaModel>,
    ctx_tokens: u32,
}

#[derive(Default)]
struct Slot {
    /// The loaded model. The tokio mutex doubles as the generation gate.
    loaded: tokio::sync::Mutex<Option<LoadedModel>>,
    /// Mirror of (model id, file size) for cheap synchronous reads.
    info: Mutex<Option<(String, u64)>>,
}

fn set_slot_info(slot: &Slot, value: Option<(String, u64)>) {
    if let Ok(mut info) = slot.info.lock() {
        *info = value;
    }
}

#[derive(Default)]
pub struct AssistantState {
    /// Download ids the user asked to cancel; checked between chunks.
    cancelled: Mutex<HashSet<String>>,
    /// Model slots, indexed via `slot_index` ("main" | "router" | "sub").
    slots: [Slot; 3],
}

/// llama.cpp allows exactly one backend initialisation per process.
static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();

fn backend() -> CmdResult<&'static LlamaBackend> {
    if let Some(b) = BACKEND.get() {
        return Ok(b);
    }
    match LlamaBackend::init() {
        Ok(mut b) => {
            b.void_logs();
            let _ = BACKEND.set(b);
        }
        Err(e) => {
            // A racing thread may have initialised it first; only fail
            // if the backend really is unavailable.
            if BACKEND.get().is_none() {
                return Err(format!("llama backend init failed: {e}"));
            }
        }
    }
    BACKEND.get().ok_or_else(|| "llama backend unavailable".to_string())
}

/* ── Pure helpers (unit-tested) ───────────────────────────────────────── */

fn validate_model_id(id: &str) -> CmdResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid model id \"{id}\" (allowed: a-z 0-9 . -)"))
    }
}

/// Strict allowlist for model download URLs. Only `https` on the exact host
/// `huggingface.co` is accepted – no other scheme, no userinfo, no port, no
/// sub/suffix domains. Parsed by hand (no url crate) so lenient URL
/// normalisation can never widen the allowlist behind our back.
fn is_allowed_model_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    // Authority = everything up to the first path/query/fragment delimiter.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // Reject userinfo ("user@host") and port ("host:port") tricks outright,
    // then require an exact host match – no subdomains, no suffix domains.
    if authority.contains('@') || authority.contains(':') {
        return false;
    }
    authority == "huggingface.co"
}

fn slot_index(slot: &str) -> CmdResult<usize> {
    SLOT_NAMES
        .iter()
        .position(|s| *s == slot)
        .ok_or_else(|| format!("invalid slot \"{slot}\" (allowed: {})", SLOT_NAMES.join(", ")))
}

/// RAM guard: the already loaded models plus the new one, with a 1.4x
/// overhead factor, must stay strictly below total RAM.
fn fits_in_ram(loaded_bytes: &[u64], new_bytes: u64, total_ram_mb: u64) -> bool {
    let needed: u128 =
        loaded_bytes.iter().map(|&b| u128::from(b)).sum::<u128>() + u128::from(new_bytes);
    let total_bytes = u128::from(total_ram_mb) * 1024 * 1024;
    // needed * 1.4 < total  ⇔  needed * 14 < total * 10 (integer-exact)
    needed * 14 < total_bytes * 10
}

/// ChatML prompt in the Qwen3 format; `/no_think` disables thinking mode.
fn build_chatml_prompt(system: &str, user: &str) -> String {
    format!(
        "<|im_start|>system\n{system} /no_think<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
    )
}

/// Gemma has no system role – the system text is prepended to the first
/// user turn.
fn build_gemma_prompt(system: &str, user: &str) -> String {
    format!("<start_of_turn>user\n{system}\n\n{user}<end_of_turn>\n<start_of_turn>model\n")
}

fn build_llama3_prompt(system: &str, user: &str) -> String {
    format!(
        "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
    )
}

fn build_phi_prompt(system: &str, user: &str) -> String {
    format!(
        "<|im_start|>system<|im_sep|>{system}<|im_end|><|im_start|>user<|im_sep|>{user}<|im_end|><|im_start|>assistant<|im_sep|>"
    )
}

fn build_prompt(template: &str, system: &str, user: &str) -> CmdResult<String> {
    match template {
        "chatml" => Ok(build_chatml_prompt(system, user)),
        "gemma" => Ok(build_gemma_prompt(system, user)),
        "llama3" => Ok(build_llama3_prompt(system, user)),
        "phi" => Ok(build_phi_prompt(system, user)),
        _ => Err(format!(
            "invalid template \"{template}\" (allowed: chatml, gemma, llama3, phi)"
        )),
    }
}

/// Defensively removes `<think>...</think>` blocks (and an unclosed
/// trailing `<think>`), plus a stray `<|im_end|>`, then trims.
fn strip_think(text: &str) -> String {
    let mut out = text.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(rel_end) => out.replace_range(start..start + rel_end + "</think>".len(), ""),
            None => {
                out.truncate(start);
                break;
            }
        }
    }
    if let Some(pos) = out.find("<|im_end|>") {
        out.truncate(pos);
    }
    out.trim().to_string()
}

/* ── Paths ────────────────────────────────────────────────────────────── */

fn models_dir(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &tauri::AppHandle, id: &str) -> CmdResult<PathBuf> {
    validate_model_id(id)?;
    Ok(models_dir(app)?.join(format!("{id}.gguf")))
}

pub(crate) fn assistant_dir(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("assistant"))
}

/* ── Scoped assistant documents (pure path logic, unit-tested) ────────── */

/// Doc/profile/memory ids: ^[a-z0-9-]{1,64}$
fn validate_doc_id(id: &str) -> CmdResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid doc id \"{id}\" (allowed: a-z 0-9 -, max 64 chars)"))
    }
}

/// Relative path of a scoped doc under <app_data_dir>/assistant/.
/// - scope "profile": kinds personality|instructions → profiles/<id>/<kind>.md
/// - scope "memory": kind memory → memories/<id>.md
/// - scope "team-competences": kind ignored → team-kompetenzen.md
///   (the id is validated for defence in depth but otherwise ignored)
fn doc_relpath(scope: &str, id: &str, kind: &str) -> CmdResult<PathBuf> {
    validate_doc_id(id)?;
    match scope {
        "profile" => {
            if kind != "personality" && kind != "instructions" {
                return Err(format!(
                    "invalid doc kind \"{kind}\" for scope \"profile\" (allowed: personality, instructions)"
                ));
            }
            Ok(PathBuf::from("profiles").join(id).join(format!("{kind}.md")))
        }
        "memory" => {
            if kind != "memory" {
                return Err(format!(
                    "invalid doc kind \"{kind}\" for scope \"memory\" (allowed: memory)"
                ));
            }
            Ok(PathBuf::from("memories").join(format!("{id}.md")))
        }
        "team-competences" => Ok(PathBuf::from("team-kompetenzen.md")),
        _ => Err(format!(
            "invalid doc scope \"{scope}\" (allowed: profile, memory, team-competences)"
        )),
    }
}

/// Moves v1 single-file docs into the scoped layout. Returns true if
/// anything was moved; a second run is a no-op returning false.
fn migrate_v1_at(base: &Path) -> CmdResult<bool> {
    const MOVES: [(&str, &[&str]); 3] = [
        ("personality.md", &["profiles", "default", "personality.md"]),
        ("instructions.md", &["profiles", "default", "instructions.md"]),
        ("memory.md", &["memories", "shared.md"]),
    ];
    let mut moved = false;
    for (old, new_parts) in MOVES {
        let from = base.join(old);
        if !from.is_file() {
            continue;
        }
        let to = new_parts.iter().fold(base.to_path_buf(), |p, part| p.join(part));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        moved = true;
    }
    Ok(moved)
}

/* ── Hardware info ────────────────────────────────────────────────────── */

fn total_ram_mb() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory() / (1024 * 1024)
}

#[tauri::command]
pub fn assistant_hw_info() -> Value {
    let cpu_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
    json!({
        "totalRamMb": total_ram_mb(),
        "cpuCores": cpu_cores,
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
        "appleSilicon": apple_silicon,
    })
}

/* ── Model files ──────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn assistant_list_models(app: tauri::AppHandle) -> CmdResult<Vec<Value>> {
    let dir = models_dir(&app)?;
    let mut models = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("gguf") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        models.push(json!({ "id": stem, "sizeBytes": size }));
    }
    models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(models)
}

fn is_cancelled(state: &AssistantState, id: &str) -> bool {
    state
        .cancelled
        .lock()
        .map(|mut set| set.remove(id))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn assistant_download_model(
    app: tauri::AppHandle,
    state: State<'_, AssistantState>,
    id: String,
    url: String,
) -> CmdResult<()> {
    if !is_allowed_model_url(&url) {
        return Err("only https://huggingface.co/ download URLs are allowed".into());
    }
    let final_path = model_path(&app, &id)?;
    let part_path = final_path.with_extension("gguf.part");

    // Forget stale cancel requests from a previous attempt.
    if let Ok(mut set) = state.cancelled.lock() {
        set.remove(&id);
    }

    // Bad networks must fail fast, not hang: connect timeout + per-chunk
    // stall detection (large downloads can take long, so no total timeout).
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }
    let total_bytes = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("cannot create {}: {e}", part_path.display()))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;

    let cleanup = |file: tokio::fs::File| {
        drop(file);
        let _ = std::fs::remove_file(&part_path);
    };

    while let Some(chunk) = stream.next().await {
        if is_cancelled(&state, &id) {
            cleanup(file);
            return Err("cancelled".into());
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                cleanup(file);
                return Err(format!("download failed: {e}"));
            }
        };
        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            cleanup(file);
            return Err(format!("write failed: {e}"));
        }
        downloaded += chunk.len() as u64;
        if downloaded - last_emitted >= PROGRESS_EVERY_BYTES {
            last_emitted = downloaded;
            let _ = app.emit(
                PROGRESS_EVENT,
                json!({ "id": id, "downloadedBytes": downloaded, "totalBytes": total_bytes }),
            );
        }
    }

    if let Err(e) = tokio::io::AsyncWriteExt::flush(&mut file).await {
        cleanup(file);
        return Err(format!("write failed: {e}"));
    }
    drop(file);

    if total_bytes > 0 && downloaded != total_bytes {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!("download incomplete: {downloaded} of {total_bytes} bytes"));
    }

    std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    let _ = app.emit(
        PROGRESS_EVENT,
        json!({ "id": id, "downloadedBytes": downloaded, "totalBytes": downloaded }),
    );
    Ok(())
}

#[tauri::command]
pub fn assistant_cancel_download(state: State<'_, AssistantState>, id: String) {
    if let Ok(mut set) = state.cancelled.lock() {
        set.insert(id);
    }
}

#[tauri::command]
pub async fn assistant_delete_model(
    app: tauri::AppHandle,
    state: State<'_, AssistantState>,
    id: String,
) -> CmdResult<()> {
    let path = model_path(&app, &id)?;
    // Unload first from every slot that holds this model.
    for slot in &state.slots {
        let mut loaded = slot.loaded.lock().await;
        if loaded.as_ref().is_some_and(|m| m.id == id) {
            *loaded = None;
            set_slot_info(slot, None);
        }
    }
    std::fs::remove_file(&path).map_err(|e| format!("cannot delete model \"{id}\": {e}"))
}

/* ── Model lifecycle ──────────────────────────────────────────────────── */

#[tauri::command]
pub async fn assistant_load_model(
    app: tauri::AppHandle,
    state: State<'_, AssistantState>,
    id: String,
    ctx_tokens: u32,
    slot: String,
) -> CmdResult<()> {
    if ctx_tokens == 0 {
        return Err("ctx_tokens must be greater than 0".into());
    }
    let idx = slot_index(&slot)?;
    let path = model_path(&app, &id)?;
    if !path.is_file() {
        return Err(format!("model \"{id}\" is not downloaded"));
    }
    let size_bytes = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();

    let slot_state = &state.slots[idx];
    let mut loaded = slot_state.loaded.lock().await;
    // Free the previous model in this slot before allocating the new one.
    *loaded = None;
    set_slot_info(slot_state, None);

    // RAM guard: models loaded in the other slots plus the new one.
    let other_bytes: Vec<u64> = state
        .slots
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != idx)
        .filter_map(|(_, s)| s.info.lock().ok().and_then(|info| info.as_ref().map(|(_, b)| *b)))
        .collect();
    if !fits_in_ram(&other_bytes, size_bytes, total_ram_mb()) {
        return Err("insufficient-ram".into());
    }

    let model = tauri::async_runtime::spawn_blocking(move || -> CmdResult<LlamaModel> {
        let backend = backend()?;
        #[cfg(target_os = "macos")]
        let params = LlamaModelParams::default().with_n_gpu_layers(999);
        #[cfg(not(target_os = "macos"))]
        let params = LlamaModelParams::default();
        LlamaModel::load_from_file(backend, &path, &params)
            .map_err(|e| format!("failed to load model: {e}"))
    })
    .await
    .map_err(|e| format!("model load task failed: {e}"))??;

    *loaded = Some(LoadedModel { id: id.clone(), model: Arc::new(model), ctx_tokens });
    set_slot_info(slot_state, Some((id, size_bytes)));
    Ok(())
}

#[tauri::command]
pub fn assistant_loaded_model(
    state: State<'_, AssistantState>,
    slot: String,
) -> CmdResult<Option<String>> {
    let idx = slot_index(&slot)?;
    Ok(state.slots[idx]
        .info
        .lock()
        .ok()
        .and_then(|info| info.as_ref().map(|(id, _)| id.clone())))
}

#[tauri::command]
pub async fn assistant_unload_model(
    state: State<'_, AssistantState>,
    slot: String,
) -> CmdResult<()> {
    let idx = slot_index(&slot)?;
    let slot_state = &state.slots[idx];
    let mut loaded = slot_state.loaded.lock().await;
    *loaded = None;
    set_slot_info(slot_state, None);
    Ok(())
}

/* ── Generation ───────────────────────────────────────────────────────── */

fn build_sampler(model: &LlamaModel, json_only: bool) -> CmdResult<LlamaSampler> {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(42);
    let mut chain = Vec::new();
    if json_only {
        let grammar = LlamaSampler::grammar(model, PROPOSAL_GRAMMAR, "root")
            .map_err(|e| format!("json grammar init failed: {e}"))?;
        chain.push(grammar);
    }
    chain.push(LlamaSampler::top_p(0.9, 1));
    chain.push(LlamaSampler::temp(0.2));
    chain.push(LlamaSampler::dist(seed));
    Ok(LlamaSampler::chain_simple(chain))
}

fn token_bytes(model: &LlamaModel, token: LlamaToken) -> CmdResult<Vec<u8>> {
    use llama_cpp_2::TokenToStringError;
    match model.token_to_piece_bytes(token, 64, false, None) {
        Ok(bytes) => Ok(bytes),
        Err(TokenToStringError::InsufficientBufferSpace(needed)) => {
            let needed = usize::try_from(-needed).unwrap_or(512);
            model
                .token_to_piece_bytes(token, needed, false, None)
                .map_err(|e| format!("token decode failed: {e}"))
        }
        Err(e) => Err(format!("token decode failed: {e}")),
    }
}

fn generate_blocking(
    model: &LlamaModel,
    ctx_tokens: u32,
    prompt: &str,
    max_tokens: u32,
    json_only: bool,
) -> CmdResult<String> {
    let backend = backend()?;
    let n_ctx = ctx_tokens.max(512);
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_batch(n_ctx);
    let mut ctx = model
        .new_context(backend, ctx_params)
        .map_err(|e| format!("failed to create context: {e}"))?;

    let tokens = model
        .str_to_token(prompt, AddBos::Always)
        .map_err(|e| format!("tokenization failed: {e}"))?;
    if tokens.is_empty() {
        return Err("empty prompt".into());
    }
    let prompt_len = u32::try_from(tokens.len()).map_err(|_| "prompt too long".to_string())?;
    if prompt_len + 4 >= n_ctx {
        return Err(format!("prompt too long: {prompt_len} tokens for context of {n_ctx}"));
    }

    let mut batch = LlamaBatch::new(n_ctx as usize, 1);
    let last_index = tokens.len() - 1;
    for (i, token) in tokens.iter().enumerate() {
        batch
            .add(*token, i as i32, &[0], i == last_index)
            .map_err(|e| format!("batch error: {e}"))?;
    }
    ctx.decode(&mut batch).map_err(|e| format!("decode failed: {e}"))?;

    let mut sampler = build_sampler(model, json_only)?;
    let budget = max_tokens.min(n_ctx - prompt_len - 1) as usize;
    let mut out_bytes: Vec<u8> = Vec::new();

    for pos in (prompt_len as i32..).take(budget) {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        if model.is_eog_token(token) {
            break;
        }
        out_bytes.extend_from_slice(&token_bytes(model, token)?);
        batch.clear();
        batch
            .add(token, pos, &[0], true)
            .map_err(|e| format!("batch error: {e}"))?;
        ctx.decode(&mut batch).map_err(|e| format!("decode failed: {e}"))?;
    }

    Ok(strip_think(&String::from_utf8_lossy(&out_bytes)))
}

#[tauri::command]
pub async fn assistant_generate(
    state: State<'_, AssistantState>,
    system: String,
    user: String,
    max_tokens: u32,
    json_only: bool,
    template: String,
    slot: String,
) -> CmdResult<String> {
    let prompt = build_prompt(&template, &system, &user)?;
    let idx = slot_index(&slot)?;
    // try_lock doubles as the "one generation at a time per slot" gate.
    let guard = state.slots[idx].loaded.try_lock().map_err(|_| "busy".to_string())?;
    let loaded = guard.as_ref().ok_or_else(|| "no model loaded".to_string())?;
    let model = Arc::clone(&loaded.model);
    let ctx_tokens = loaded.ctx_tokens;

    // The guard stays held across the await, so load/unload/delete wait
    // and a second generate call on this slot fails fast with "busy".
    tauri::async_runtime::spawn_blocking(move || {
        generate_blocking(&model, ctx_tokens, &prompt, max_tokens, json_only)
    })
    .await
    .map_err(|e| format!("generation task failed: {e}"))?
}

/* ── Assistant documents ──────────────────────────────────────────────── */

#[tauri::command]
pub async fn assistant_read_doc(
    app: tauri::AppHandle,
    scope: String,
    id: String,
    kind: String,
) -> CmdResult<String> {
    let path = assistant_dir(&app)?.join(doc_relpath(&scope, &id, &kind)?);
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn assistant_write_doc(
    app: tauri::AppHandle,
    scope: String,
    id: String,
    kind: String,
    content: String,
) -> CmdResult<()> {
    let path = assistant_dir(&app)?.join(doc_relpath(&scope, &id, &kind)?);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Removes everything stored for (scope, id). Missing files/folders are
/// fine – deletion is idempotent.
#[tauri::command]
pub async fn assistant_delete_docs(
    app: tauri::AppHandle,
    scope: String,
    id: String,
) -> CmdResult<()> {
    validate_doc_id(&id)?;
    let base = assistant_dir(&app)?;
    let target = match scope.as_str() {
        "profile" => base.join("profiles").join(&id),
        "memory" => base.join("memories").join(format!("{id}.md")),
        "team-competences" => base.join("team-kompetenzen.md"),
        _ => {
            return Err(format!(
                "invalid doc scope \"{scope}\" (allowed: profile, memory, team-competences)"
            ))
        }
    };
    if !target.exists() {
        return Ok(());
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn assistant_list_doc_ids(app: tauri::AppHandle, scope: String) -> CmdResult<Vec<String>> {
    let base = assistant_dir(&app)?;
    let mut ids = Vec::new();
    match scope.as_str() {
        "profile" => {
            let dir = base.join("profiles");
            if dir.is_dir() {
                for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if !entry.path().is_dir() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    if validate_doc_id(&name).is_ok() {
                        ids.push(name);
                    }
                }
            }
        }
        "memory" => {
            let dir = base.join("memories");
            if dir.is_dir() {
                for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path = entry.path();
                    if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
                        continue;
                    }
                    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                    if validate_doc_id(stem).is_ok() {
                        ids.push(stem.to_string());
                    }
                }
            }
        }
        "team-competences" => {
            if base.join("team-kompetenzen.md").is_file() {
                ids.push("global".to_string());
            }
        }
        _ => {
            return Err(format!(
                "invalid doc scope \"{scope}\" (allowed: profile, memory, team-competences)"
            ))
        }
    }
    ids.sort();
    Ok(ids)
}

/// Moves pre-0.4.0 docs (assistant/{personality,instructions,memory}.md)
/// into the scoped layout. Returns true if anything was moved.
#[tauri::command]
pub async fn assistant_migrate_v1(app: tauri::AppHandle) -> CmdResult<bool> {
    let base = assistant_dir(&app)?;
    if !base.is_dir() {
        return Ok(false);
    }
    migrate_v1_at(&base)
}

/* ── Tests ────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_id_validation() {
        for good in ["qwen3-4b-q4", "tiny.model-1", "a", "0.5b"] {
            assert!(validate_model_id(good).is_ok(), "should accept {good:?}");
        }
        for bad in [
            "",
            "Qwen3",
            "has_underscore",
            "has space",
            "a/b",
            "..",
            ".hidden",
            "a\\b",
            "über",
        ] {
            assert!(validate_model_id(bad).is_err(), "should reject {bad:?}");
        }
        let too_long = "a".repeat(129);
        assert!(validate_model_id(&too_long).is_err());
    }

    #[test]
    fn slot_name_mapping() {
        assert_eq!(slot_index("main").unwrap(), 0);
        assert_eq!(slot_index("router").unwrap(), 1);
        assert_eq!(slot_index("sub").unwrap(), 2);
        for bad in ["", "Main", "primary", "main "] {
            assert!(slot_index(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn chatml_prompt_shape() {
        let p = build_prompt("chatml", "You are helpful.", "Hi!").unwrap();
        assert_eq!(
            p,
            "<|im_start|>system\nYou are helpful. /no_think<|im_end|>\n<|im_start|>user\nHi!<|im_end|>\n<|im_start|>assistant\n"
        );
    }

    #[test]
    fn gemma_prompt_shape() {
        let p = build_prompt("gemma", "You are helpful.", "Hi!").unwrap();
        assert_eq!(
            p,
            "<start_of_turn>user\nYou are helpful.\n\nHi!<end_of_turn>\n<start_of_turn>model\n"
        );
    }

    #[test]
    fn llama3_prompt_shape() {
        let p = build_prompt("llama3", "You are helpful.", "Hi!").unwrap();
        assert_eq!(
            p,
            "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nYou are helpful.<|eot_id|><|start_header_id|>user<|end_header_id|>\n\nHi!<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
        );
    }

    #[test]
    fn phi_prompt_shape() {
        let p = build_prompt("phi", "You are helpful.", "Hi!").unwrap();
        assert_eq!(
            p,
            "<|im_start|>system<|im_sep|>You are helpful.<|im_end|><|im_start|>user<|im_sep|>Hi!<|im_end|><|im_start|>assistant<|im_sep|>"
        );
    }

    #[test]
    fn unknown_template_rejected() {
        for bad in ["", "ChatML", "mistral", "llama2"] {
            assert!(build_prompt(bad, "s", "u").is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn ram_guard() {
        const MIB: u64 = 1024 * 1024;
        // Fits comfortably: 2 GiB loaded + 2 GiB new, 16 GiB RAM.
        assert!(fits_in_ram(&[2048 * MIB], 2048 * MIB, 16 * 1024));
        // Nothing loaded yet, small model, small RAM.
        assert!(fits_in_ram(&[], 10 * MIB, 15));
        // Exact boundary: (10 MiB) * 1.4 == 14 MiB total → NOT allowed.
        assert!(!fits_in_ram(&[], 10 * MIB, 14));
        // Just above the boundary is fine.
        assert!(fits_in_ram(&[], 10 * MIB, 15));
        // Exceeds: 6 GiB + 6 GiB on a 16 GiB machine (needs 16.8 GiB).
        assert!(!fits_in_ram(&[6144 * MIB], 6144 * MIB, 16 * 1024));
        // Multiple loaded slots are summed.
        assert!(!fits_in_ram(&[4096 * MIB, 4096 * MIB], 4096 * MIB, 16 * 1024));
        assert!(fits_in_ram(&[1024 * MIB, 1024 * MIB], 1024 * MIB, 16 * 1024));
    }

    #[test]
    fn doc_id_validation() {
        for good in ["default", "shared", "abc-123", "a", &"a".repeat(64)] {
            assert!(validate_doc_id(good).is_ok(), "should accept {good:?}");
        }
        for bad in ["../x", "A", "", "a_b", "a b", "a/b", "a.b", &"a".repeat(65)] {
            assert!(validate_doc_id(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn doc_paths_per_scope() {
        assert_eq!(
            doc_relpath("profile", "default", "personality").unwrap(),
            PathBuf::from("profiles/default/personality.md")
        );
        assert_eq!(
            doc_relpath("profile", "coach", "instructions").unwrap(),
            PathBuf::from("profiles/coach/instructions.md")
        );
        assert_eq!(
            doc_relpath("memory", "shared", "memory").unwrap(),
            PathBuf::from("memories/shared.md")
        );
        assert_eq!(
            doc_relpath("team-competences", "global", "whatever").unwrap(),
            PathBuf::from("team-kompetenzen.md")
        );

        // Kind allowlists per scope.
        assert!(doc_relpath("profile", "default", "memory").is_err());
        assert!(doc_relpath("profile", "default", "").is_err());
        assert!(doc_relpath("memory", "shared", "personality").is_err());
        // Unknown scope.
        assert!(doc_relpath("notes", "default", "personality").is_err());
        assert!(doc_relpath("", "default", "personality").is_err());
    }

    #[test]
    fn doc_bad_ids_rejected_in_every_scope() {
        let long = "a".repeat(65);
        for scope in ["profile", "memory", "team-competences"] {
            let kind = match scope {
                "profile" => "personality",
                "memory" => "memory",
                _ => "ignored",
            };
            for bad in ["../x", "A", "", long.as_str()] {
                assert!(
                    doc_relpath(scope, bad, kind).is_err(),
                    "scope {scope:?} should reject id {bad:?}"
                );
            }
        }
    }

    #[test]
    fn migration_moves_v1_docs_and_is_idempotent() {
        let base = std::env::temp_dir()
            .join(format!("cardo-assistant-migrate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        std::fs::write(base.join("personality.md"), "P").unwrap();
        std::fs::write(base.join("instructions.md"), "I").unwrap();
        std::fs::write(base.join("memory.md"), "M").unwrap();

        assert!(migrate_v1_at(&base).unwrap(), "first run should move files");
        assert!(!base.join("personality.md").exists());
        assert!(!base.join("instructions.md").exists());
        assert!(!base.join("memory.md").exists());
        assert_eq!(
            std::fs::read_to_string(base.join("profiles/default/personality.md")).unwrap(),
            "P"
        );
        assert_eq!(
            std::fs::read_to_string(base.join("profiles/default/instructions.md")).unwrap(),
            "I"
        );
        assert_eq!(std::fs::read_to_string(base.join("memories/shared.md")).unwrap(), "M");

        assert!(!migrate_v1_at(&base).unwrap(), "second run should be a no-op");

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn migration_moves_partial_set() {
        let base = std::env::temp_dir()
            .join(format!("cardo-assistant-migrate-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        std::fs::write(base.join("memory.md"), "only me").unwrap();
        assert!(migrate_v1_at(&base).unwrap());
        assert_eq!(
            std::fs::read_to_string(base.join("memories/shared.md")).unwrap(),
            "only me"
        );
        assert!(!base.join("profiles").exists() || !base.join("profiles/default/personality.md").exists());
        assert!(!migrate_v1_at(&base).unwrap());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn think_stripping() {
        assert_eq!(strip_think("plain answer"), "plain answer");
        assert_eq!(strip_think("<think>reasoning</think>\n\nanswer"), "answer");
        assert_eq!(strip_think("a <think>x</think>b<think>y</think> c"), "a b c");
        assert_eq!(strip_think("answer<think>unclosed trailing"), "answer");
        assert_eq!(strip_think("answer<|im_end|>junk"), "answer");
        assert_eq!(strip_think("<think>only thinking</think>"), "");
    }

    #[test]
    fn allowed_model_url_accepts_catalog_and_rejects_spoofs() {
        // Three real catalog URLs; all 18 entries share this scheme+host and
        // differ only in the path, so the host check covers every one.
        let good = [
            "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
            "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
            "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
        ];
        for url in good {
            assert!(is_allowed_model_url(url), "should accept {url:?}");
        }
        // The shared catalog pattern: https://huggingface.co/<anything>.
        assert!(is_allowed_model_url("https://huggingface.co/x/y/z.gguf"));
        assert!(is_allowed_model_url("https://huggingface.co/"));

        let bad = [
            "http://huggingface.co/x",                  // plain http
            "https://huggingface.co.evil.com/x",        // suffix domain
            "https://evil.com/https://huggingface.co/", // real host is evil.com
            "https://huggingface.co@evil.com/x",        // userinfo trick
            "https://huggingface.co:1337@evil.com/",    // port + userinfo trick
            "ftp://huggingface.co/",                    // wrong scheme
            "totally not a url",                        // garbage
            "https://sub.huggingface.co/x",             // subdomain
            "https://huggingface.co:443/x",             // explicit port
            "https://HUGGINGFACE.CO/x",                 // case (host must match exactly)
            "//huggingface.co/x",                       // scheme-relative
            "https:/huggingface.co/x",                  // malformed scheme sep
            "",                                         // empty
        ];
        for url in bad {
            assert!(!is_allowed_model_url(url), "should reject {url:?}");
        }
    }

    #[test]
    fn doc_scope_matrix_adversarial() {
        // Ids that must be rejected everywhere (validate_doc_id runs first).
        let long = "a".repeat(65);
        let bad_ids = ["A", "a b", "a/../b", "", long.as_str()];

        for scope in ["profile", "memory"] {
            let kind = if scope == "profile" { "personality" } else { "memory" };
            for id in bad_ids {
                assert!(
                    doc_relpath(scope, id, kind).is_err(),
                    "scope {scope:?} must reject id {id:?}"
                );
            }
        }
        // team-competences validates the id for defence in depth, then ignores it.
        for id in bad_ids {
            assert!(
                doc_relpath("team-competences", id, "ignored").is_err(),
                "team-competences must reject bad id {id:?}"
            );
        }
        assert_eq!(
            doc_relpath("team-competences", "global", "whatever").unwrap(),
            PathBuf::from("team-kompetenzen.md")
        );

        // Bogus scope is rejected even with an otherwise valid id.
        assert!(doc_relpath("bogus", "valid-id", "personality").is_err());
        assert!(doc_relpath("", "valid-id", "personality").is_err());
    }

    #[test]
    fn json_grammar_is_nonempty_and_has_root() {
        assert!(PROPOSAL_GRAMMAR.contains("\\\"proposals\\\""));
        assert!(PROPOSAL_GRAMMAR.contains("optdelegate"));
    }

    /// LIVE test with a real model – excluded from CI (network + 400 MB).
    /// Run before releases: cargo test -p cardo-desktop --release live_ -- --ignored --nocapture
    #[test]
    #[ignore = "downloads a real 400 MB model; run manually before releases"]
    fn live_generate_qwen3_0_6b() {
        let model_path = std::env::temp_dir().join("cardo-live-qwen3-0.6b.gguf");
        if !model_path.is_file() {
            let status = std::process::Command::new("curl")
                .args([
                    "-fsSL",
                    "-o",
                    model_path.to_str().expect("temp path utf8"),
                    "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
                ])
                .status()
                .expect("curl available");
            assert!(status.success(), "model download failed");
        }

        let backend = backend().expect("backend");
        #[cfg(target_os = "macos")]
        let params = LlamaModelParams::default().with_n_gpu_layers(999);
        #[cfg(not(target_os = "macos"))]
        let params = LlamaModelParams::default();
        let model =
            LlamaModel::load_from_file(backend, &model_path, &params).expect("model loads");

        // 1. Proposal round: braindump → grammar-constrained JSON with commands.
        let system = "Du bist der Cardo-Assistent. Verfügbare Befehle:\n\
            - todo.create {title: string, due?: string}: Aufgabe anlegen\n\
            - calendar.create {title: string, date: string, time?: string}: Termin anlegen\n\
            Heute ist der 2026-07-12. Antworte NUR mit JSON: {\"reply\": string, \
            \"proposals\": [{\"command\": string, \"params\": object, \"summary\": string}], \
            \"memory\": []}";
        let user = "morgen um 9 Uhr Zahnarzt, und ich muss Milch kaufen";
        let prompt = build_prompt("chatml", system, user).expect("prompt");
        let out = generate_blocking(&model, 2048, &prompt, 512, true).expect("generation");
        println!("LIVE proposal output: {out}");
        let parsed: serde_json::Value = serde_json::from_str(out.trim()).expect("valid JSON");
        let proposals = parsed["proposals"].as_array().expect("proposals array");
        assert!(!proposals.is_empty(), "expected at least one proposal");
        let commands: Vec<String> = proposals
            .iter()
            .filter_map(|p| p["command"].as_str().map(String::from))
            .collect();
        assert!(
            commands.iter().any(|c| c.contains("todo") || c.contains("calendar")),
            "expected a todo/calendar proposal, got {commands:?}"
        );

        // 2. Router round: pick a team member for a writing task.
        let router_system = "Du bist der Team-Router. Mitglieder:\n\
            - hanna: Termine und Aufgabenplanung\n\
            - felix: Briefe und E-Mails formulieren\n\
            Antworte NUR mit der ID des passendsten Mitglieds (hanna oder felix).";
        let router_prompt =
            build_prompt("chatml", router_system, "Schreib einen Brief an meine Versicherung")
                .expect("router prompt");
        let route = generate_blocking(&model, 1024, &router_prompt, 16, false).expect("routing");
        println!("LIVE router output: {route}");
        assert!(
            route.to_lowercase().contains("felix") || route.to_lowercase().contains("hanna"),
            "router must name a member, got: {route}"
        );
    }
}
