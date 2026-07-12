//! Local LLM assistant engine: GGUF models via llama.cpp, fully offline.
//! Models are downloaded from HuggingFace on user request into
//! <app_data_dir>/models/ and loaded on demand. Generation runs on a
//! blocking thread; a tokio mutex serialises access (one generation at
//! a time – a concurrent caller gets Err("busy")).

use std::collections::HashSet;
use std::num::NonZeroU32;
use std::path::PathBuf;
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
const JSON_GRAMMAR: &str = r#"root   ::= object
value  ::= object | array | string | number | ("true" | "false" | "null")

object ::=
  "{" (
            string ":" value
    ("," string ":" value)*
  )? "}"

array  ::=
  "[" (
            value
    ("," value)*
  )? "]"

string ::=
  "\"" (
    [^"\\] |
    "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
  )* "\""

number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
"#;

const DOC_KINDS: [&str; 3] = ["instructions", "personality", "memory"];
const PROGRESS_EVENT: &str = "assistant:download-progress";
const PROGRESS_EVERY_BYTES: u64 = 2 * 1024 * 1024;

/* ── State ────────────────────────────────────────────────────────────── */

struct LoadedModel {
    id: String,
    model: Arc<LlamaModel>,
    ctx_tokens: u32,
}

#[derive(Default)]
pub struct AssistantState {
    /// Download ids the user asked to cancel; checked between chunks.
    cancelled: Mutex<HashSet<String>>,
    /// The loaded model. The tokio mutex doubles as the generation gate.
    loaded: tokio::sync::Mutex<Option<LoadedModel>>,
    /// Mirror of the loaded model id for cheap synchronous reads.
    loaded_id: Mutex<Option<String>>,
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

fn validate_doc_kind(kind: &str) -> CmdResult<()> {
    if DOC_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("invalid doc kind \"{kind}\" (allowed: {})", DOC_KINDS.join(", ")))
    }
}

/// ChatML prompt in the Qwen3 format; `/no_think` disables thinking mode.
fn build_chatml_prompt(system: &str, user: &str) -> String {
    format!(
        "<|im_start|>system\n{system} /no_think<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
    )
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

fn doc_path(app: &tauri::AppHandle, kind: &str) -> CmdResult<PathBuf> {
    validate_doc_kind(kind)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("assistant");
    Ok(dir.join(format!("{kind}.md")))
}

/* ── Hardware info ────────────────────────────────────────────────────── */

#[tauri::command]
pub fn assistant_hw_info() -> Value {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_ram_mb = sys.total_memory() / (1024 * 1024);
    let cpu_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
    json!({
        "totalRamMb": total_ram_mb,
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
    if !url.starts_with("https://huggingface.co/") {
        return Err("only https://huggingface.co/ download URLs are allowed".into());
    }
    let final_path = model_path(&app, &id)?;
    let part_path = final_path.with_extension("gguf.part");

    // Forget stale cancel requests from a previous attempt.
    if let Ok(mut set) = state.cancelled.lock() {
        set.remove(&id);
    }

    let response = reqwest::get(&url).await.map_err(|e| format!("download failed: {e}"))?;
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
    // Unload first if this model is currently loaded.
    {
        let mut loaded = state.loaded.lock().await;
        if loaded.as_ref().is_some_and(|m| m.id == id) {
            *loaded = None;
            if let Ok(mut lid) = state.loaded_id.lock() {
                *lid = None;
            }
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
) -> CmdResult<()> {
    if ctx_tokens == 0 {
        return Err("ctx_tokens must be greater than 0".into());
    }
    let path = model_path(&app, &id)?;
    if !path.is_file() {
        return Err(format!("model \"{id}\" is not downloaded"));
    }

    let mut loaded = state.loaded.lock().await;
    // Free the previous model before allocating the new one.
    *loaded = None;
    if let Ok(mut lid) = state.loaded_id.lock() {
        *lid = None;
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
    if let Ok(mut lid) = state.loaded_id.lock() {
        *lid = Some(id);
    }
    Ok(())
}

#[tauri::command]
pub fn assistant_loaded_model(state: State<'_, AssistantState>) -> Option<String> {
    state.loaded_id.lock().ok().and_then(|id| id.clone())
}

#[tauri::command]
pub async fn assistant_unload_model(state: State<'_, AssistantState>) -> CmdResult<()> {
    let mut loaded = state.loaded.lock().await;
    *loaded = None;
    if let Ok(mut lid) = state.loaded_id.lock() {
        *lid = None;
    }
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
        let grammar = LlamaSampler::grammar(model, JSON_GRAMMAR, "root")
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
) -> CmdResult<String> {
    // try_lock doubles as the "one generation at a time" gate.
    let guard = state.loaded.try_lock().map_err(|_| "busy".to_string())?;
    let loaded = guard.as_ref().ok_or_else(|| "no model loaded".to_string())?;
    let model = Arc::clone(&loaded.model);
    let ctx_tokens = loaded.ctx_tokens;
    let prompt = build_chatml_prompt(&system, &user);

    // The guard stays held across the await, so load/unload/delete wait
    // and a second generate call fails fast with "busy".
    tauri::async_runtime::spawn_blocking(move || {
        generate_blocking(&model, ctx_tokens, &prompt, max_tokens, json_only)
    })
    .await
    .map_err(|e| format!("generation task failed: {e}"))?
}

/* ── Assistant documents ──────────────────────────────────────────────── */

#[tauri::command]
pub async fn assistant_read_doc(app: tauri::AppHandle, kind: String) -> CmdResult<String> {
    let path = doc_path(&app, &kind)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn assistant_write_doc(
    app: tauri::AppHandle,
    kind: String,
    content: String,
) -> CmdResult<()> {
    let path = doc_path(&app, &kind)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
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
    fn doc_kind_allowlist() {
        for good in ["instructions", "personality", "memory"] {
            assert!(validate_doc_kind(good).is_ok());
        }
        for bad in ["", "Instructions", "memory.md", "../memory", "notes"] {
            assert!(validate_doc_kind(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn chatml_prompt_shape() {
        let p = build_chatml_prompt("You are helpful.", "Hi!");
        assert_eq!(
            p,
            "<|im_start|>system\nYou are helpful. /no_think<|im_end|>\n<|im_start|>user\nHi!<|im_end|>\n<|im_start|>assistant\n"
        );
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
    fn json_grammar_is_nonempty_and_has_root() {
        assert!(JSON_GRAMMAR.contains("root"));
        assert!(JSON_GRAMMAR.contains("object"));
    }
}
