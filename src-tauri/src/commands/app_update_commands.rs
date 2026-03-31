use super::PendingAppUpdate;
use serde::Serialize;
use tauri::{command, AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

pub(crate) const APP_UPDATE_STATUS_EVENT: &str = "app-update-status";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateStatusPayload {
    status: String,
}

fn emit_status(app: &AppHandle, status: impl Into<String>) {
    let _ = app.emit(
        APP_UPDATE_STATUS_EVENT,
        AppUpdateStatusPayload {
            status: status.into(),
        },
    );
}

#[command]
pub fn get_current_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[command]
pub async fn check_for_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
) -> Result<Option<AppUpdateMetadata>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let metadata = update.as_ref().map(|update| AppUpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    });

    let mut state = pending_update
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *state = update;

    Ok(metadata)
}

#[command]
pub async fn install_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
) -> Result<(), String> {
    let update = {
        let mut state = pending_update
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.take()
    }
    .ok_or_else(|| "No pending update is available to install.".to_string())?;

    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut started = false;
    let mut downloaded_bytes = 0_u64;
    let mut last_reported_bucket = None::<u64>;

    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);

                if !started {
                    started = true;
                    let started_message = content_length
                        .filter(|length| *length > 0)
                        .map(|length| {
                            format!(
                                "Downloading update ({} MB)…",
                                (length as f64 / 1024.0 / 1024.0).round() as u64
                            )
                        })
                        .unwrap_or_else(|| "Downloading update…".to_string());
                    emit_status(&progress_app, started_message);
                }

                if let Some(total_length) = content_length.filter(|length| *length > 0) {
                    let clamped_downloaded = downloaded_bytes.min(total_length);
                    let percent = clamped_downloaded.saturating_mul(100) / total_length;
                    let bucket = percent / 5;

                    if last_reported_bucket != Some(bucket) {
                        last_reported_bucket = Some(bucket);
                        emit_status(
                            &progress_app,
                            format!(
                                "Downloading update… {}% ({:.1}/{:.1} MB)",
                                percent,
                                clamped_downloaded as f64 / 1024.0 / 1024.0,
                                total_length as f64 / 1024.0 / 1024.0
                            ),
                        );
                    }
                }
            },
            move || {
                emit_status(&finish_app, "Installing update…");
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    emit_status(&app, "Restarting app…");
    app.restart();
}
