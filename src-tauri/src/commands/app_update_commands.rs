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

    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let started_message = content_length
                        .map(|length| {
                            format!(
                                "Downloading update ({} MB)…",
                                (length as f64 / 1024.0 / 1024.0).round() as u64
                            )
                        })
                        .unwrap_or_else(|| "Downloading update…".to_string());
                    emit_status(&progress_app, started_message);
                } else if chunk_length > 0 {
                    emit_status(&progress_app, "Downloading update…");
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