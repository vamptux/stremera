use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, RANGE, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};

const USER_AGENT_STRING: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DOWNLOADS_FILE: &str = "downloads.json";
const ACTIVE_DOWNLOAD_TASK_ERROR: &str = "Download is already running.";
const DUPLICATE_DOWNLOAD_TARGET_ERROR: &str =
    "A download already exists for this destination. Remove it first or choose a different file name.";
const MAX_DOWNLOAD_RETRY_ATTEMPTS: u32 = 3;
const INITIAL_DOWNLOAD_RETRY_DELAY_MS: u64 = 1_500;
const MAX_DOWNLOAD_FILE_NAME_CHARS: usize = 180;
const WINDOWS_RESERVED_FILE_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn unix_timestamp_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn parse_content_length(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|len| len.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
}

fn normalize_download_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Download URL is required.".to_string());
    }

    let mut parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| "Invalid download URL. Please provide a valid http(s) URL.".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => {
            return Err("Download URL must start with http:// or https://".to_string());
        }
    }

    if parsed.host_str().is_none() {
        return Err("Download URL must include a valid host.".to_string());
    }

    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn truncate_file_name(stem: &str, extension: Option<&str>) -> String {
    let extension_len = extension.map(|ext| ext.chars().count() + 1).unwrap_or(0);
    let max_stem_chars = MAX_DOWNLOAD_FILE_NAME_CHARS
        .saturating_sub(extension_len)
        .max(1);
    let truncated_stem: String = stem.chars().take(max_stem_chars).collect();

    match extension {
        Some(ext) if !ext.is_empty() => format!("{}.{}", truncated_stem, ext),
        _ => truncated_stem,
    }
}

fn sanitize_download_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("Download file name is required.".to_string());
    }

    let leaf_name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed).trim();

    if leaf_name.is_empty() {
        return Err("Download file name is invalid.".to_string());
    }

    let mut sanitized: String = leaf_name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => ch,
        })
        .collect();

    sanitized = sanitized
        .trim_matches(|c: char| c == ' ' || c == '.')
        .to_string();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err("Download file name is invalid.".to_string());
    }

    let reserved_stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase();
    if WINDOWS_RESERVED_FILE_STEMS.contains(&reserved_stem.as_str()) {
        sanitized = format!("_{}", sanitized);
    }

    if sanitized.chars().count() > MAX_DOWNLOAD_FILE_NAME_CHARS {
        let (stem, extension) = match sanitized.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
                (stem.to_string(), Some(extension.to_string()))
            }
            _ => (sanitized.clone(), None),
        };

        sanitized = truncate_file_name(&stem, extension.as_deref());
    }

    Ok(sanitized)
}

fn normalize_download_directory(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("Download path is required.".to_string());
    }

    let path = PathBuf::from(trimmed);
    if path.as_os_str().is_empty() {
        return Err("Download path is invalid.".to_string());
    }

    Ok(path)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_download_media_type(media_type: Option<String>) -> Option<String> {
    normalize_optional_text(media_type).and_then(|value| {
        let lowered = value.to_ascii_lowercase();
        match lowered.as_str() {
            "movie" | "series" | "anime" => Some(lowered),
            _ => None,
        }
    })
}

fn build_download_target_path(
    file_path: &str,
    file_name: &str,
) -> Result<(String, String, PathBuf), String> {
    let directory = normalize_download_directory(file_path)?;
    let sanitized_file_name = sanitize_download_file_name(file_name)?;
    let full_path = directory.join(&sanitized_file_name);
    Ok((
        directory.to_string_lossy().to_string(),
        sanitized_file_name,
        full_path,
    ))
}

fn normalize_path_key(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn should_retry_http_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status.as_u16(),
        408 | 409 | 425 | 429 | 500 | 502 | 503 | 504
    )
}

fn should_retry_reqwest_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

fn retry_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(4);
    Duration::from_millis(INITIAL_DOWNLOAD_RETRY_DELAY_MS.saturating_mul(1u64 << exponent))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Paused,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub file_path: String,
    pub file_name: String,
    pub total_size: u64,
    pub downloaded_size: u64,
    pub speed: u64,    // bytes per second
    pub progress: f64, // 0.0 to 100.0
    pub status: DownloadStatus,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub poster: Option<String>,
    pub media_type: Option<String>, // "movie" | "series" | "anime"
    pub bandwidth_limit: Option<u64>,
    pub media_id: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub id: String,
    pub downloaded_size: u64,
    pub total_size: u64,
    pub speed: u64,
    pub progress: f64,
    pub status: DownloadStatus,
}

pub struct DownloadManager {
    downloads: Arc<Mutex<HashMap<String, DownloadItem>>>,
    abort_handles: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    bandwidth_limit: Arc<Mutex<Option<u64>>>, // bytes per second, global limit
    /// Serialises concurrent disk writes so a slow save from task A can never
    /// be overwritten by a stale snapshot from task B that serialised earlier.
    save_lock: Arc<Mutex<()>>,
    /// Last successfully saved JSON snapshot; used to skip redundant disk writes.
    last_saved_snapshot: Arc<Mutex<Option<String>>>,
    /// Shared HTTP client — reused across all download tasks so that TCP
    /// connections are pooled and TLS handshakes are amortised.
    http_client: reqwest::Client,
    app_handle: AppHandle,
}

struct DownloadStateUpdate {
    status: DownloadStatus,
    error: Option<String>,
    downloaded_size: Option<u64>,
    total_size: Option<u64>,
    speed: Option<u64>,
    progress: Option<f64>,
}

fn compute_download_progress(
    downloaded_size: u64,
    total_size: u64,
    status: &DownloadStatus,
) -> f64 {
    if total_size > 0 {
        ((downloaded_size as f64 / total_size as f64) * 100.0).clamp(0.0, 100.0)
    } else if *status == DownloadStatus::Completed {
        100.0
    } else {
        0.0
    }
}

fn build_progress_event(item: &DownloadItem) -> DownloadProgressEvent {
    DownloadProgressEvent {
        id: item.id.clone(),
        downloaded_size: item.downloaded_size,
        total_size: item.total_size,
        speed: item.speed,
        progress: item.progress,
        status: item.status.clone(),
    }
}

fn emit_download_progress_events(app_handle: &AppHandle, events: Vec<DownloadProgressEvent>) {
    for event in events {
        let _ = app_handle.emit("download://progress", event);
    }
}

async fn apply_download_state_update(
    downloads: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    save_lock: &Arc<Mutex<()>>,
    app_handle: &AppHandle,
    id: &str,
    update: DownloadStateUpdate,
    persist: bool,
) {
    let event = {
        let mut guard = downloads.lock().await;
        let Some(item) = guard.get_mut(id) else {
            return;
        };

        if let Some(downloaded_size) = update.downloaded_size {
            item.downloaded_size = downloaded_size;
        }
        if let Some(total_size) = update.total_size {
            item.total_size = total_size;
        }
        if let Some(speed) = update.speed {
            item.speed = speed;
        }

        item.status = update.status;
        item.error = update.error;
        item.updated_at = unix_timestamp_secs();
        item.progress = update
            .progress
            .map(|value| value.clamp(0.0, 100.0))
            .unwrap_or_else(|| {
                compute_download_progress(item.downloaded_size, item.total_size, &item.status)
            });

        build_progress_event(item)
    };

    let _ = app_handle.emit("download://progress", event);
    if persist {
        save_to_disk(downloads, save_lock, app_handle).await;
    }
}

fn write_download_snapshot_blocking(path: &Path, downloads: &HashMap<String, DownloadItem>) {
    let Ok(json) = serde_json::to_string_pretty(downloads) else {
        return;
    };

    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &json).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Write the current downloads map to disk atomically (tmp file → rename).
/// Acquiring the downloads lock inside an explicit block ensures the guard is
/// dropped *before* any async I/O, so we never hold it across await points.
async fn save_to_disk(
    downloads: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    save_lock: &Arc<Mutex<()>>,
    app_handle: &AppHandle,
) {
    let _save_guard = save_lock.lock().await;
    let Some(json) = ({
        let guard = downloads.lock().await;
        serde_json::to_string_pretty(&*guard).ok()
    }) else {
        return;
    };

    if let Ok(app_dir) = app_handle.path().app_data_dir() {
        if !app_dir.exists() {
            let _ = tokio::fs::create_dir_all(&app_dir).await;
        }

        let path = app_dir.join(DOWNLOADS_FILE);
        let tmp = path.with_extension("json.tmp");
        if tokio::fs::write(&tmp, &json).await.is_ok()
            && tokio::fs::rename(&tmp, &path).await.is_err()
        {
            let _ = tokio::fs::remove_file(&path).await;
            let _ = tokio::fs::rename(&tmp, &path).await;
        }
    }
}

async fn save_to_disk_if_changed(
    downloads: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    save_lock: &Arc<Mutex<()>>,
    last_saved_snapshot: &Arc<Mutex<Option<String>>>,
    app_handle: &AppHandle,
) {
    let _save_guard = save_lock.lock().await;
    let Some(json) = ({
        let guard = downloads.lock().await;
        serde_json::to_string_pretty(&*guard).ok()
    }) else {
        return;
    };

    {
        let snapshot = last_saved_snapshot.lock().await;
        if snapshot.as_deref() == Some(json.as_str()) {
            return;
        }
    }

    if let Ok(app_dir) = app_handle.path().app_data_dir() {
        if !app_dir.exists() {
            let _ = tokio::fs::create_dir_all(&app_dir).await;
        }

        let path = app_dir.join(DOWNLOADS_FILE);
        let tmp = path.with_extension("json.tmp");
        if tokio::fs::write(&tmp, &json).await.is_ok()
            && tokio::fs::rename(&tmp, &path).await.is_err()
        {
            let _ = tokio::fs::remove_file(&path).await;
            let _ = tokio::fs::rename(&tmp, &path).await;
        }

        let mut snapshot = last_saved_snapshot.lock().await;
        *snapshot = Some(json);
    }
}

async fn run_download_task(
    downloads: Arc<Mutex<HashMap<String, DownloadItem>>>,
    save_lock: Arc<Mutex<()>>,
    last_saved_snapshot: Arc<Mutex<Option<String>>>,
    bandwidth_limit: Arc<Mutex<Option<u64>>>,
    app_handle: AppHandle,
    client: reqwest::Client,
    id: String,
) {
    let (url, file_path, file_name, mut downloaded_size, mut item_bandwidth_limit, start_event) = {
        let mut guard = downloads.lock().await;
        let Some(item) = guard.get_mut(&id) else {
            return;
        };

        item.status = DownloadStatus::Downloading;
        item.error = None;
        item.speed = 0;
        item.updated_at = unix_timestamp_secs();

        (
            item.url.clone(),
            item.file_path.clone(),
            item.file_name.clone(),
            item.downloaded_size,
            item.bandwidth_limit,
            build_progress_event(item),
        )
    };

    let _ = app_handle.emit("download://progress", start_event);

    let full_path = PathBuf::from(&file_path).join(&file_name);

    if let Some(parent) = full_path.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            apply_download_state_update(
                &downloads,
                &save_lock,
                &app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Error,
                    error: Some(format!("File error: {}", error)),
                    downloaded_size: Some(downloaded_size),
                    total_size: None,
                    speed: Some(0),
                    progress: None,
                },
                true,
            )
            .await;
            return;
        }
    }

    let mut total_size = {
        let guard = downloads.lock().await;
        guard.get(&id).map(|item| item.total_size).unwrap_or(0)
    };

    if total_size == 0 {
        if let Ok(response) = client
            .head(&url)
            .header(USER_AGENT, USER_AGENT_STRING)
            .send()
            .await
        {
            if let Some(val) = parse_content_length(response.headers()) {
                total_size = val;
                let mut should_persist = false;
                {
                    let mut guard = downloads.lock().await;
                    if let Some(item) = guard.get_mut(&id) {
                        if item.total_size != total_size {
                            item.total_size = total_size;
                            item.updated_at = unix_timestamp_secs();
                            should_persist = true;
                        }
                    }
                }
                if should_persist {
                    save_to_disk_if_changed(
                        &downloads,
                        &save_lock,
                        &last_saved_snapshot,
                        &app_handle,
                    )
                    .await;
                }
            }
        }
    }

    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&full_path)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            apply_download_state_update(
                &downloads,
                &save_lock,
                &app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Error,
                    error: Some(format!("File error: {}", error)),
                    downloaded_size: Some(downloaded_size),
                    total_size: Some(total_size),
                    speed: Some(0),
                    progress: None,
                },
                true,
            )
            .await;
            return;
        }
    };

    if let Ok(metadata) = file.metadata().await {
        let on_disk = metadata.len();
        let should_persist = downloaded_size != on_disk;
        downloaded_size = on_disk;

        {
            let mut guard = downloads.lock().await;
            if let Some(item) = guard.get_mut(&id) {
                item.downloaded_size = downloaded_size;
                item.progress =
                    compute_download_progress(downloaded_size, total_size, &item.status);
                item.updated_at = unix_timestamp_secs();
            }
        }

        if should_persist {
            save_to_disk_if_changed(&downloads, &save_lock, &last_saved_snapshot, &app_handle)
                .await;
        }

        if let Err(error) = file.seek(SeekFrom::Start(downloaded_size)).await {
            apply_download_state_update(
                &downloads,
                &save_lock,
                &app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Error,
                    error: Some(format!("File error: {}", error)),
                    downloaded_size: Some(downloaded_size),
                    total_size: Some(total_size),
                    speed: Some(0),
                    progress: None,
                },
                true,
            )
            .await;
            return;
        }
    }

    if total_size > 0 && downloaded_size >= total_size {
        if let Err(error) = file.flush().await {
            apply_download_state_update(
                &downloads,
                &save_lock,
                &app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Error,
                    error: Some(format!("Write error: {}", error)),
                    downloaded_size: Some(downloaded_size),
                    total_size: Some(total_size),
                    speed: Some(0),
                    progress: None,
                },
                true,
            )
            .await;
            return;
        }

        apply_download_state_update(
            &downloads,
            &save_lock,
            &app_handle,
            &id,
            DownloadStateUpdate {
                status: DownloadStatus::Completed,
                error: None,
                downloaded_size: Some(downloaded_size),
                total_size: Some(total_size),
                speed: Some(0),
                progress: Some(100.0),
            },
            true,
        )
        .await;
        return;
    }

    let emit_interval = Duration::from_millis(500);
    let mut transient_retry_count = 0u32;

    'download: loop {
        let response = match client
            .get(&url)
            .header(USER_AGENT, USER_AGENT_STRING)
            .header(RANGE, format!("bytes={}-", downloaded_size))
            .send()
            .await
        {
            Ok(response) => {
                if response.status().as_u16() == 416 {
                    let on_disk_size = tokio::fs::metadata(&full_path)
                        .await
                        .map(|metadata| metadata.len())
                        .unwrap_or(0);
                    let is_truncated = on_disk_size < downloaded_size;

                    if is_truncated {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[Downloader] 416 truncation detected — on-disk {} B vs recorded {} B ; resetting to on-disk size",
                            on_disk_size, downloaded_size
                        );

                        let _ = file.seek(SeekFrom::Start(on_disk_size)).await;
                        let truncated_progress = if total_size > 0 {
                            compute_download_progress(
                                on_disk_size,
                                total_size,
                                &DownloadStatus::Paused,
                            )
                            .min(99.9)
                        } else {
                            0.0
                        };

                        apply_download_state_update(
                            &downloads,
                            &save_lock,
                            &app_handle,
                            &id,
                            DownloadStateUpdate {
                                status: DownloadStatus::Paused,
                                error: Some(
                                    "Download file was truncated; resume to complete.".to_string(),
                                ),
                                downloaded_size: Some(on_disk_size),
                                total_size: Some(total_size),
                                speed: Some(0),
                                progress: Some(truncated_progress),
                            },
                            true,
                        )
                        .await;
                    } else {
                        let final_total_size = if total_size == 0 {
                            on_disk_size
                        } else {
                            total_size
                        };

                        apply_download_state_update(
                            &downloads,
                            &save_lock,
                            &app_handle,
                            &id,
                            DownloadStateUpdate {
                                status: DownloadStatus::Completed,
                                error: None,
                                downloaded_size: Some(on_disk_size.max(downloaded_size)),
                                total_size: Some(final_total_size),
                                speed: Some(0),
                                progress: Some(100.0),
                            },
                            true,
                        )
                        .await;
                    }

                    return;
                }

                if !response.status().is_success() {
                    if should_retry_http_status(response.status())
                        && transient_retry_count < MAX_DOWNLOAD_RETRY_ATTEMPTS
                    {
                        transient_retry_count += 1;
                        sleep(retry_delay(transient_retry_count)).await;
                        continue 'download;
                    }

                    apply_download_state_update(
                        &downloads,
                        &save_lock,
                        &app_handle,
                        &id,
                        DownloadStateUpdate {
                            status: DownloadStatus::Error,
                            error: Some(format!("HTTP Error: {}", response.status())),
                            downloaded_size: Some(downloaded_size),
                            total_size: Some(total_size),
                            speed: Some(0),
                            progress: None,
                        },
                        true,
                    )
                    .await;
                    return;
                }

                response
            }
            Err(error) => {
                if should_retry_reqwest_error(&error)
                    && transient_retry_count < MAX_DOWNLOAD_RETRY_ATTEMPTS
                {
                    transient_retry_count += 1;
                    sleep(retry_delay(transient_retry_count)).await;
                    continue 'download;
                }

                apply_download_state_update(
                    &downloads,
                    &save_lock,
                    &app_handle,
                    &id,
                    DownloadStateUpdate {
                        status: DownloadStatus::Error,
                        error: Some(format!("Request Error: {}", error)),
                        downloaded_size: Some(downloaded_size),
                        total_size: Some(total_size),
                        speed: Some(0),
                        progress: None,
                    },
                    true,
                )
                .await;
                return;
            }
        };

        if response.status().as_u16() == 200 && downloaded_size > 0 {
            downloaded_size = 0;
            if let Err(error) = file.set_len(0).await {
                apply_download_state_update(
                    &downloads,
                    &save_lock,
                    &app_handle,
                    &id,
                    DownloadStateUpdate {
                        status: DownloadStatus::Error,
                        error: Some(format!("File error: {}", error)),
                        downloaded_size: Some(downloaded_size),
                        total_size: Some(total_size),
                        speed: Some(0),
                        progress: None,
                    },
                    true,
                )
                .await;
                return;
            }

            if let Err(error) = file.seek(SeekFrom::Start(0)).await {
                apply_download_state_update(
                    &downloads,
                    &save_lock,
                    &app_handle,
                    &id,
                    DownloadStateUpdate {
                        status: DownloadStatus::Error,
                        error: Some(format!("File error: {}", error)),
                        downloaded_size: Some(0),
                        total_size: Some(total_size),
                        speed: Some(0),
                        progress: None,
                    },
                    true,
                )
                .await;
                return;
            }

            let mut guard = downloads.lock().await;
            if let Some(item) = guard.get_mut(&id) {
                item.downloaded_size = 0;
                item.progress = compute_download_progress(0, item.total_size, &item.status);
                item.updated_at = unix_timestamp_secs();
            }
        }

        if let Some(val) = parse_content_length(response.headers()) {
            let new_total = downloaded_size + val;
            if total_size == 0 || total_size != new_total {
                total_size = new_total;
                let mut should_persist = false;
                {
                    let mut guard = downloads.lock().await;
                    if let Some(item) = guard.get_mut(&id) {
                        if item.total_size != total_size {
                            item.total_size = total_size;
                            item.progress = compute_download_progress(
                                item.downloaded_size,
                                item.total_size,
                                &item.status,
                            );
                            item.updated_at = unix_timestamp_secs();
                            should_persist = true;
                        }
                    }
                }

                if should_persist {
                    save_to_disk_if_changed(
                        &downloads,
                        &save_lock,
                        &last_saved_snapshot,
                        &app_handle,
                    )
                    .await;
                }
            }
        }

        let mut stream = response.bytes_stream();
        let mut last_emit = Instant::now();
        let mut bytes_since_last_emit = 0u64;
        let mut throttle_window_start = Instant::now();
        let mut throttle_bytes: u64 = 0;
        let mut cached_global_limit: Option<u64> = *bandwidth_limit.lock().await;

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(chunk) => {
                    transient_retry_count = 0;
                    chunk
                }
                Err(error) => {
                    if should_retry_reqwest_error(&error)
                        && transient_retry_count < MAX_DOWNLOAD_RETRY_ATTEMPTS
                    {
                        transient_retry_count += 1;
                        sleep(retry_delay(transient_retry_count)).await;
                        continue 'download;
                    }

                    apply_download_state_update(
                        &downloads,
                        &save_lock,
                        &app_handle,
                        &id,
                        DownloadStateUpdate {
                            status: DownloadStatus::Error,
                            error: Some(format!("Stream Error: {}", error)),
                            downloaded_size: Some(downloaded_size),
                            total_size: Some(total_size),
                            speed: Some(0),
                            progress: None,
                        },
                        true,
                    )
                    .await;
                    return;
                }
            };

            let limit = match (cached_global_limit, item_bandwidth_limit) {
                (Some(global), Some(item)) => Some(std::cmp::min(global, item)),
                (Some(global), None) => Some(global),
                (None, Some(item)) => Some(item),
                (None, None) => None,
            };

            if let Some(bytes_per_second) = limit {
                if bytes_per_second > 0 {
                    throttle_bytes += chunk.len() as u64;
                    let expected_elapsed =
                        Duration::from_secs_f64(throttle_bytes as f64 / bytes_per_second as f64);
                    let actual_elapsed = throttle_window_start.elapsed();
                    if expected_elapsed > actual_elapsed {
                        sleep(expected_elapsed - actual_elapsed).await;
                    }
                    if throttle_window_start.elapsed() >= Duration::from_secs(1) {
                        throttle_window_start = Instant::now();
                        throttle_bytes = 0;
                    }
                }
            } else {
                throttle_window_start = Instant::now();
                throttle_bytes = 0;
            }

            if let Err(error) = file.write_all(&chunk).await {
                apply_download_state_update(
                    &downloads,
                    &save_lock,
                    &app_handle,
                    &id,
                    DownloadStateUpdate {
                        status: DownloadStatus::Error,
                        error: Some(format!("Write Error: {}", error)),
                        downloaded_size: Some(downloaded_size),
                        total_size: Some(total_size),
                        speed: Some(0),
                        progress: None,
                    },
                    true,
                )
                .await;
                return;
            }

            downloaded_size += chunk.len() as u64;
            bytes_since_last_emit += chunk.len() as u64;

            if last_emit.elapsed() >= emit_interval {
                let speed =
                    (bytes_since_last_emit as f64 / last_emit.elapsed().as_secs_f64()) as u64;
                let event = {
                    let mut guard = downloads.lock().await;
                    if let Some(item) = guard.get_mut(&id) {
                        item.downloaded_size = downloaded_size;
                        item.speed = speed;
                        item.progress = compute_download_progress(
                            downloaded_size,
                            item.total_size,
                            &DownloadStatus::Downloading,
                        );
                        item.updated_at = unix_timestamp_secs();
                        item_bandwidth_limit = item.bandwidth_limit;
                        Some(build_progress_event(item))
                    } else {
                        None
                    }
                };

                if let Some(event) = event {
                    let _ = app_handle.emit("download://progress", event);
                }

                cached_global_limit = *bandwidth_limit.lock().await;
                last_emit = Instant::now();
                bytes_since_last_emit = 0;
            }
        }

        break;
    }

    if let Err(error) = file.flush().await {
        apply_download_state_update(
            &downloads,
            &save_lock,
            &app_handle,
            &id,
            DownloadStateUpdate {
                status: DownloadStatus::Error,
                error: Some(format!("Write error: {}", error)),
                downloaded_size: Some(downloaded_size),
                total_size: Some(total_size),
                speed: Some(0),
                progress: None,
            },
            true,
        )
        .await;
        return;
    }

    let final_total_size = if total_size == 0 {
        downloaded_size
    } else {
        total_size
    };

    apply_download_state_update(
        &downloads,
        &save_lock,
        &app_handle,
        &id,
        DownloadStateUpdate {
            status: DownloadStatus::Completed,
            error: None,
            downloaded_size: Some(downloaded_size),
            total_size: Some(final_total_size),
            speed: Some(0),
            progress: Some(100.0),
        },
        true,
    )
    .await;
}

impl DownloadManager {
    pub fn new(app_handle: AppHandle) -> Self {
        let http_client = reqwest::Client::builder()
            .user_agent(USER_AGENT_STRING)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(3600)) // 1 hr — generous for large downloads
            .pool_max_idle_per_host(4)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let manager = Self {
            downloads: Arc::new(Mutex::new(HashMap::new())),
            abort_handles: Arc::new(Mutex::new(HashMap::new())),
            bandwidth_limit: Arc::new(Mutex::new(None)), // No limit by default
            save_lock: Arc::new(Mutex::new(())),
            last_saved_snapshot: Arc::new(Mutex::new(None)),
            http_client,
            app_handle,
        };
        manager.load_downloads();
        manager
    }

    fn get_downloads_file_path(&self) -> Option<PathBuf> {
        self.app_handle.path().app_data_dir().ok().map(|d| {
            if !d.exists() {
                let _ = std::fs::create_dir_all(&d);
            }
            d.join(DOWNLOADS_FILE)
        })
    }

    fn load_downloads(&self) {
        if let Some(path) = self.get_downloads_file_path() {
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    match serde_json::from_str::<HashMap<String, DownloadItem>>(&content) {
                        Ok(items) => {
                            let mut downloads = self.downloads.blocking_lock();
                            *downloads = items;
                            let mut needs_save = false;

                            // Reset status of interrupted downloads to Paused or Pending
                            for item in downloads.values_mut() {
                                let trimmed_title = item.title.trim();
                                if !trimmed_title.is_empty() && trimmed_title != item.title {
                                    item.title = trimmed_title.to_string();
                                    needs_save = true;
                                }

                                let trimmed_path = item.file_path.trim();
                                if trimmed_path.is_empty() {
                                    item.status = DownloadStatus::Error;
                                    item.error =
                                        Some("Stored download path is invalid".to_string());
                                    item.speed = 0;
                                    item.updated_at = unix_timestamp_secs();
                                    needs_save = true;
                                    continue;
                                }
                                if trimmed_path != item.file_path {
                                    item.file_path = trimmed_path.to_string();
                                    needs_save = true;
                                }

                                match sanitize_download_file_name(&item.file_name) {
                                    Ok(sanitized_file_name) => {
                                        if sanitized_file_name != item.file_name {
                                            item.file_name = sanitized_file_name;
                                            needs_save = true;
                                        }
                                    }
                                    Err(_) => {
                                        item.status = DownloadStatus::Error;
                                        item.error = Some(
                                            "Stored download file name is invalid".to_string(),
                                        );
                                        item.speed = 0;
                                        item.updated_at = unix_timestamp_secs();
                                        needs_save = true;
                                        continue;
                                    }
                                }

                                match normalize_download_url(&item.url) {
                                    Ok(normalized_url) => {
                                        if normalized_url != item.url {
                                            item.url = normalized_url;
                                            needs_save = true;
                                        }
                                    }
                                    Err(_) if item.status != DownloadStatus::Completed => {
                                        item.status = DownloadStatus::Error;
                                        item.error =
                                            Some("Stored download URL is invalid".to_string());
                                        item.speed = 0;
                                        item.updated_at = unix_timestamp_secs();
                                        needs_save = true;
                                        continue;
                                    }
                                    Err(_) => {}
                                }

                                if item.status == DownloadStatus::Downloading
                                    || item.status == DownloadStatus::Pending
                                {
                                    item.status = DownloadStatus::Paused;
                                    item.speed = 0;
                                    item.updated_at = unix_timestamp_secs();
                                    needs_save = true;
                                }

                                // Check actual file size on disk
                                let full_path =
                                    PathBuf::from(&item.file_path).join(&item.file_name);
                                if let Ok(metadata) = std::fs::metadata(&full_path) {
                                    let on_disk = metadata.len();
                                    if item.downloaded_size != on_disk {
                                        needs_save = true;
                                    }
                                    item.downloaded_size = on_disk;

                                    if item.total_size > 0 {
                                        item.progress = compute_download_progress(
                                            on_disk,
                                            item.total_size,
                                            &item.status,
                                        );
                                        if on_disk >= item.total_size {
                                            item.status = DownloadStatus::Completed;
                                            item.progress = 100.0;
                                            item.speed = 0;
                                            item.updated_at = unix_timestamp_secs();
                                            needs_save = true;
                                        }
                                    }
                                } else if item.status == DownloadStatus::Completed {
                                    // If it was marked completed but file is missing, mark as error
                                    item.status = DownloadStatus::Error;
                                    item.error = Some("File missing from disk".to_string());
                                    item.speed = 0;
                                    item.updated_at = unix_timestamp_secs();
                                    needs_save = true;
                                }
                            }

                            if needs_save {
                                write_download_snapshot_blocking(&path, &downloads);
                                if let Ok(json) = serde_json::to_string_pretty(&*downloads) {
                                    let mut snapshot = self.last_saved_snapshot.blocking_lock();
                                    *snapshot = Some(json);
                                }
                            } else {
                                let mut snapshot = self.last_saved_snapshot.blocking_lock();
                                *snapshot = Some(content);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to parse downloads.json: {}", e);
                        }
                    }
                } else {
                    eprintln!("Failed to read downloads.json");
                }
            }
        }
    }

    async fn save_downloads(&self) {
        save_to_disk_if_changed(
            &self.downloads,
            &self.save_lock,
            &self.last_saved_snapshot,
            &self.app_handle,
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_download(
        &self,
        title: String,
        url: String,
        file_path: String,
        file_name: String,
        poster: Option<String>,
        media_type: Option<String>,
        bandwidth_limit: Option<u64>,
        media_id: Option<String>,
        season: Option<u32>,
        episode: Option<u32>,
    ) -> Result<String, String> {
        let normalized_url = normalize_download_url(&url)?;
        let (normalized_file_path, normalized_file_name, full_path) =
            build_download_target_path(&file_path, &file_name)?;
        let normalized_title = {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                normalized_file_name.clone()
            } else {
                trimmed.to_string()
            }
        };
        let normalized_poster = normalize_optional_text(poster);
        let normalized_media_type = normalize_download_media_type(media_type);
        let normalized_media_id = normalize_optional_text(media_id);
        let target_key = normalize_path_key(&full_path);

        {
            let downloads = self.downloads.lock().await;
            if downloads.values().any(|item| {
                normalize_path_key(&PathBuf::from(&item.file_path).join(&item.file_name))
                    == target_key
            }) {
                return Err(DUPLICATE_DOWNLOAD_TARGET_ERROR.to_string());
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let download_item = DownloadItem {
            id: id.clone(),
            title: normalized_title,
            url: normalized_url,
            file_path: normalized_file_path,
            file_name: normalized_file_name,
            total_size: 0,
            downloaded_size: 0,
            speed: 0,
            progress: 0.0,
            status: DownloadStatus::Pending,
            error: None,
            created_at: unix_timestamp_secs(),
            updated_at: unix_timestamp_secs(),
            poster: normalized_poster,
            media_type: normalized_media_type,
            bandwidth_limit,
            media_id: normalized_media_id,
            season,
            episode,
        };

        {
            let mut downloads = self.downloads.lock().await;
            downloads.insert(id.clone(), download_item.clone());
        }
        self.save_downloads().await;

        if let Err(error) = self.spawn_download_task(id.clone()).await {
            let mut downloads = self.downloads.lock().await;
            downloads.remove(&id);
            drop(downloads);
            self.save_downloads().await;
            return Err(error);
        }

        Ok(id)
    }

    async fn spawn_download_task(&self, id: String) -> Result<(), String> {
        let mut handles = self.abort_handles.lock().await;
        if handles.contains_key(&id) {
            return Err(ACTIVE_DOWNLOAD_TASK_ERROR.to_string());
        }

        let downloads = self.downloads.clone();
        let save_lock = self.save_lock.clone();
        let last_saved_snapshot = self.last_saved_snapshot.clone();
        let bandwidth_limit = self.bandwidth_limit.clone();
        let app_handle = self.app_handle.clone();
        let client = self.http_client.clone();
        let cleanup_handles = self.abort_handles.clone();
        let cleanup_id = id.clone();
        let task_id = id.clone();

        let task = tokio::spawn(async move {
            run_download_task(
                downloads,
                save_lock,
                last_saved_snapshot,
                bandwidth_limit,
                app_handle,
                client,
                task_id,
            )
            .await;

            let mut handles = cleanup_handles.lock().await;
            handles.remove(&cleanup_id);
        });

        handles.insert(id, task);
        Ok(())
    }

    pub async fn pause_download(&self, id: String) -> Result<(), String> {
        // Abort the running task (no-op if already finished)
        {
            let mut handles = self.abort_handles.lock().await;
            if let Some(handle) = handles.remove(&id) {
                handle.abort();
            }
        }
        // Only flip status if the download is still actively in-progress.
        // Never overwrite Completed, Error, or already-Paused.
        let should_pause = {
            let mut downloads = self.downloads.lock().await;
            if let Some(item) = downloads.get_mut(&id) {
                matches!(
                    item.status,
                    DownloadStatus::Downloading | DownloadStatus::Pending
                )
            } else {
                false
            }
        };

        if should_pause {
            apply_download_state_update(
                &self.downloads,
                &self.save_lock,
                &self.app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Paused,
                    error: None,
                    downloaded_size: None,
                    total_size: None,
                    speed: Some(0),
                    progress: None,
                },
                true,
            )
            .await;
        }
        Ok(())
    }

    pub async fn pause_active_downloads(&self) -> usize {
        let active_ids = {
            let downloads = self.downloads.lock().await;
            downloads
                .iter()
                .filter_map(|(id, item)| {
                    matches!(
                        item.status,
                        DownloadStatus::Downloading | DownloadStatus::Pending
                    )
                    .then_some(id.clone())
                })
                .collect::<Vec<_>>()
        };

        if active_ids.is_empty() {
            return 0;
        }

        {
            let mut handles = self.abort_handles.lock().await;
            for id in &active_ids {
                if let Some(handle) = handles.remove(id) {
                    handle.abort();
                }
            }
        }

        let events = {
            let mut downloads = self.downloads.lock().await;
            let mut events = Vec::with_capacity(active_ids.len());

            for id in &active_ids {
                let Some(item) = downloads.get_mut(id) else {
                    continue;
                };

                if !matches!(
                    item.status,
                    DownloadStatus::Downloading | DownloadStatus::Pending
                ) {
                    continue;
                }

                item.status = DownloadStatus::Paused;
                item.error = None;
                item.speed = 0;
                item.updated_at = unix_timestamp_secs();
                item.progress = compute_download_progress(
                    item.downloaded_size,
                    item.total_size,
                    &item.status,
                );
                events.push(build_progress_event(item));
            }

            events
        };

        if events.is_empty() {
            return 0;
        }

        emit_download_progress_events(&self.app_handle, events.clone());
        self.save_downloads().await;
        events.len()
    }

    pub async fn resume_download(&self, id: String) -> Result<(), String> {
        // Check if already downloading
        {
            let downloads = self.downloads.lock().await;
            if let Some(item) = downloads.get(&id) {
                if item.status == DownloadStatus::Downloading {
                    return Ok(());
                }
            } else {
                return Err("Download not found".to_string());
            }
        }

        {
            let handles = self.abort_handles.lock().await;
            if handles.contains_key(&id) {
                return Ok(());
            }
        }

        match self.spawn_download_task(id).await {
            Ok(()) => Ok(()),
            Err(error) if error == ACTIVE_DOWNLOAD_TASK_ERROR => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub async fn cancel_download(&self, id: String) -> Result<(), String> {
        // Abort the running task (no-op if already finished)
        {
            let mut handles = self.abort_handles.lock().await;
            if let Some(handle) = handles.remove(&id) {
                handle.abort();
            }
        }
        // Only cancel if still in-progress — don't touch completed downloads
        let should_cancel = {
            let mut downloads = self.downloads.lock().await;
            if let Some(item) = downloads.get_mut(&id) {
                matches!(
                    item.status,
                    DownloadStatus::Downloading | DownloadStatus::Pending | DownloadStatus::Paused
                )
            } else {
                false
            }
        };

        if should_cancel {
            apply_download_state_update(
                &self.downloads,
                &self.save_lock,
                &self.app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Error,
                    error: Some("Cancelled".to_string()),
                    downloaded_size: None,
                    total_size: None,
                    speed: Some(0),
                    progress: None,
                },
                true,
            )
            .await;
        }
        Ok(())
    }

    pub async fn remove_download(&self, id: String, delete_file: bool) -> Result<(), String> {
        // Silently abort any running task — do NOT call pause_download here because
        // that would mutate the status on a completed item before we remove it,
        // causing a brief bad state to be persisted if the app crashes mid-removal.
        {
            let mut handles = self.abort_handles.lock().await;
            if let Some(handle) = handles.remove(&id) {
                handle.abort();
            }
        }

        let mut file_to_delete = None;
        {
            let mut downloads = self.downloads.lock().await;
            if let Some(item) = downloads.remove(&id) {
                if delete_file {
                    file_to_delete = Some(PathBuf::from(&item.file_path).join(&item.file_name));
                }
            }
        }
        self.save_downloads().await;

        if let Some(path) = file_to_delete {
            let _ = tokio::fs::remove_file(path).await;
        }

        Ok(())
    }

    pub async fn remove_completed_downloads(&self, delete_file: bool) -> usize {
        let (completed_ids, file_paths) = {
            let mut downloads = self.downloads.lock().await;
            let completed_ids = downloads
                .iter()
                .filter_map(|(id, item)| {
                    (item.status == DownloadStatus::Completed).then_some(id.clone())
                })
                .collect::<Vec<_>>();

            if completed_ids.is_empty() {
                return 0;
            }

            let file_paths = completed_ids
                .iter()
                .filter_map(|id| downloads.get(id))
                .filter(|_| delete_file)
                .map(|item| PathBuf::from(&item.file_path).join(&item.file_name))
                .collect::<Vec<_>>();

            for id in &completed_ids {
                downloads.remove(id);
            }

            (completed_ids, file_paths)
        };

        {
            let mut handles = self.abort_handles.lock().await;
            for id in &completed_ids {
                if let Some(handle) = handles.remove(id) {
                    handle.abort();
                }
            }
        }

        self.save_downloads().await;

        for path in file_paths {
            let _ = tokio::fs::remove_file(path).await;
        }

        completed_ids.len()
    }

    /// Verifies that the on-disk file for a completed download still exists.
    ///
    /// If the file has been deleted externally since download completion, the item
    /// is transitioned to `Error` so the UI can surface a recovery action.
    /// Returns `true` if the file is present, `false` if it was missing (and
    /// therefore has been marked as `Error`).
    pub async fn check_file_exists(&self, id: String) -> Result<bool, String> {
        let (file_path, file_name, status) = {
            let downloads = self.downloads.lock().await;
            let item = downloads
                .get(&id)
                .ok_or_else(|| "Download not found".to_string())?;
            (
                item.file_path.clone(),
                item.file_name.clone(),
                item.status.clone(),
            )
        };

        // Only meaningful for completed downloads; other statuses are not expected
        // to have a final file yet.
        if status != DownloadStatus::Completed {
            return Ok(true);
        }

        let full_path = PathBuf::from(&file_path).join(&file_name);
        let exists = tokio::fs::metadata(&full_path).await.is_ok();

        if !exists {
            apply_download_state_update(
                &self.downloads,
                &self.save_lock,
                &self.app_handle,
                &id,
                DownloadStateUpdate {
                    status: DownloadStatus::Error,
                    error: Some("File was deleted from disk".to_string()),
                    downloaded_size: Some(0),
                    total_size: None,
                    speed: Some(0),
                    progress: Some(0.0),
                },
                true,
            )
            .await;
        }

        Ok(exists)
    }

    pub async fn get_downloads(&self) -> Vec<DownloadItem> {
        let downloads = self.downloads.lock().await;
        let mut items: Vec<DownloadItem> = downloads.values().cloned().collect();
        // Newest first
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    pub async fn set_bandwidth_limit(&self, limit: Option<u64>) {
        let mut lock = self.bandwidth_limit.lock().await;
        *lock = limit;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_download_file_name_removes_path_traversal_and_invalid_chars() {
        let sanitized = sanitize_download_file_name("../episode?:01.mkv").unwrap();
        assert_eq!(sanitized, "episode__01.mkv");
    }

    #[test]
    fn sanitize_download_file_name_prefixes_reserved_windows_names() {
        let sanitized = sanitize_download_file_name("con.mp4").unwrap();
        assert_eq!(sanitized, "_con.mp4");
    }

    #[test]
    fn normalize_download_url_rejects_non_http_schemes() {
        let error = normalize_download_url("ftp://example.com/video.mp4").unwrap_err();
        assert!(error.contains("http:// or https://"));
    }

    #[test]
    fn normalize_download_url_trims_and_strips_fragment() {
        let normalized =
            normalize_download_url("  https://example.com/video.mp4?token=123#section  ").unwrap();
        assert_eq!(normalized, "https://example.com/video.mp4?token=123");
    }

    #[test]
    fn retryable_http_statuses_are_limited_to_transient_failures() {
        assert!(should_retry_http_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(should_retry_http_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!should_retry_http_status(reqwest::StatusCode::NOT_FOUND));
        assert!(!should_retry_http_status(reqwest::StatusCode::UNAUTHORIZED));
    }
}
