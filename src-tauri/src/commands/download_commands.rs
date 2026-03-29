use crate::downloader::{DownloadItem, DownloadManager};
use tauri::{command, AppHandle, Manager, State};

#[command]
#[allow(clippy::too_many_arguments)]
pub async fn start_download(
    manager: State<'_, DownloadManager>,
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
    manager
        .start_download(
            title,
            url,
            file_path,
            file_name,
            poster,
            media_type,
            bandwidth_limit,
            media_id,
            season,
            episode,
        )
        .await
}

#[command]
pub async fn pause_download(manager: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    manager.pause_download(id).await
}

#[command]
pub async fn pause_active_downloads(
    manager: State<'_, DownloadManager>,
) -> Result<usize, String> {
    Ok(manager.pause_active_downloads().await)
}

#[command]
pub async fn resume_download(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.resume_download(id).await
}

#[command]
pub async fn check_download_file_exists(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<bool, String> {
    manager.check_file_exists(id).await
}

#[command]
pub async fn cancel_download(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.cancel_download(id).await
}

#[command]
pub async fn remove_download(
    manager: State<'_, DownloadManager>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    manager.remove_download(id, delete_file).await
}

#[command]
pub async fn clear_completed_downloads(
    manager: State<'_, DownloadManager>,
    delete_file: Option<bool>,
) -> Result<usize, String> {
    Ok(manager
        .remove_completed_downloads(delete_file.unwrap_or(false))
        .await)
}

#[command]
pub async fn get_downloads(
    manager: State<'_, DownloadManager>,
) -> Result<Vec<DownloadItem>, String> {
    Ok(manager.get_downloads().await)
}

#[command]
pub async fn set_download_bandwidth(
    manager: State<'_, DownloadManager>,
    limit: Option<u64>,
) -> Result<(), String> {
    manager.set_bandwidth_limit(limit).await;
    Ok(())
}

#[command]
pub fn get_default_download_path(app: AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .download_dir()
        .map(|p| p.join("Streamy"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string())
}