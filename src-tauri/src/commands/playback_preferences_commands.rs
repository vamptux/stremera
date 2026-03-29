use super::{
    normalize_non_empty, normalize_stream_media_type, now_unix_millis,
    playback_state::PlaybackStateService, PlaybackLanguagePreferences, SETTINGS_STORE_FILE,
};
use super::config_store::get_trimmed_store_string;
use serde_json::json;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

fn sanitize_language_pref(value: Option<String>) -> Option<String> {
    value
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .filter(|candidate| !candidate.is_empty())
}

#[command]
pub async fn save_playback_language_preferences(
    app: AppHandle,
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let audio = sanitize_language_pref(preferred_audio_language);
    let subtitle = sanitize_language_pref(preferred_subtitle_language);

    if let Some(value) = audio {
        store.set("preferred_audio_language", json!(value));
    } else {
        store.delete("preferred_audio_language");
    }

    if let Some(value) = subtitle {
        store.set("preferred_subtitle_language", json!(value));
    } else {
        store.delete("preferred_subtitle_language");
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn get_playback_language_preferences(
    app: AppHandle,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let preferred_audio_language =
        sanitize_language_pref(get_trimmed_store_string(&store, "preferred_audio_language"));
    let preferred_subtitle_language = sanitize_language_pref(get_trimmed_store_string(
        &store,
        "preferred_subtitle_language",
    ));

    Ok(PlaybackLanguagePreferences {
        preferred_audio_language,
        preferred_subtitle_language,
    })
}

#[command]
pub async fn get_effective_playback_language_preferences(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    media_id: Option<String>,
    media_type: Option<String>,
) -> Result<PlaybackLanguagePreferences, String> {
    let defaults = get_playback_language_preferences(app.clone()).await?;

    playback_state.get_effective_playback_language_preferences(
        &app,
        media_id.as_deref(),
        media_type.as_deref(),
        defaults,
    )
}

#[command]
pub async fn save_playback_language_preference_outcome(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    media_id: String,
    media_type: String,
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<(), String> {
    let media_id = normalize_non_empty(&media_id)
        .ok_or_else(|| "Media ID is required for playback preference outcomes.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type)
        .ok_or_else(|| "Invalid media type for playback preference outcomes.".to_string())?;

    playback_state.record_playback_language_preference_outcome(
        &app,
        &media_id,
        &media_type,
        sanitize_language_pref(preferred_audio_language),
        sanitize_language_pref(preferred_subtitle_language),
        now_unix_millis(),
    )
}