use super::config_store::get_trimmed_store_string;
use super::{
    language::{
        infer_track_preferred_language,
        normalize_language_token as normalize_backend_language_token,
        resolve_preferred_track_selection as resolve_track_language_selection,
        TrackLanguageCandidate, TrackLanguageSelectionResolution,
    },
    normalize_non_empty, normalize_stream_media_type, now_unix_millis,
    playback_state::PlaybackStateService,
    PlaybackLanguagePreferences, SETTINGS_STORE_FILE,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackLanguagePreferenceKind {
    Audio,
    Sub,
}

pub(crate) fn sanitize_language_pref(value: Option<String>, allow_off: bool) -> Option<String> {
    normalize_backend_language_token(value.as_deref(), allow_off)
}

fn read_playback_language_preferences_from_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
) -> PlaybackLanguagePreferences {
    PlaybackLanguagePreferences {
        preferred_audio_language: sanitize_language_pref(
            get_trimmed_store_string(store, "preferred_audio_language"),
            false,
        ),
        preferred_subtitle_language: sanitize_language_pref(
            get_trimmed_store_string(store, "preferred_subtitle_language"),
            true,
        ),
    }
}

fn persist_playback_language_preferences<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    preferences: &PlaybackLanguagePreferences,
) -> Result<(), String> {
    if let Some(value) = preferences.preferred_audio_language.as_ref() {
        store.set("preferred_audio_language", json!(value));
    } else {
        store.delete("preferred_audio_language");
    }

    if let Some(value) = preferences.preferred_subtitle_language.as_ref() {
        store.set("preferred_subtitle_language", json!(value));
    } else {
        store.delete("preferred_subtitle_language");
    }

    store.save().map_err(|e| e.to_string())
}

fn infer_track_preferred_language_candidate(track: Option<&TrackLanguageCandidate>) -> Option<String> {
    track.and_then(|candidate| {
        infer_track_preferred_language(candidate.lang.as_deref(), candidate.title.as_deref())
    })
}

fn infer_selected_playback_language_preference(
    preference_kind: PlaybackLanguagePreferenceKind,
    track: Option<&TrackLanguageCandidate>,
    subtitles_off: bool,
) -> Option<String> {
    match preference_kind {
        PlaybackLanguagePreferenceKind::Audio => infer_track_preferred_language_candidate(track),
        PlaybackLanguagePreferenceKind::Sub => {
            if subtitles_off {
                Some("off".to_string())
            } else {
                infer_track_preferred_language_candidate(track)
            }
        }
    }
}

#[command]
pub async fn save_playback_language_preferences(
    app: AppHandle,
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let preferences = PlaybackLanguagePreferences {
        preferred_audio_language: sanitize_language_pref(preferred_audio_language, false),
        preferred_subtitle_language: sanitize_language_pref(preferred_subtitle_language, true),
    };

    persist_playback_language_preferences(&store, &preferences)?;
    Ok(preferences)
}

#[command]
pub async fn get_playback_language_preferences(
    app: AppHandle,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    Ok(read_playback_language_preferences_from_store(&store))
}

#[command]
pub async fn get_effective_playback_language_preferences(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    media_id: Option<String>,
    media_type: Option<String>,
) -> Result<PlaybackLanguagePreferences, String> {
    let defaults = get_playback_language_preferences(app.clone()).await?;
    let media_id = media_id.as_deref().and_then(normalize_non_empty);
    let media_type = match media_type.as_deref() {
        Some(value) => Some(
            normalize_stream_media_type(value, media_id.as_deref()).ok_or_else(|| {
                "Invalid media type for playback language preferences.".to_string()
            })?,
        ),
        None => None,
    };

    playback_state.get_effective_playback_language_preferences(
        &app,
        media_id.as_deref(),
        media_type.as_deref(),
        defaults,
    )
}

#[command]
pub async fn resolve_preferred_track_selection(
    tracks: Vec<TrackLanguageCandidate>,
    preferred_language: Option<String>,
    selected_track_id: Option<i64>,
) -> Result<TrackLanguageSelectionResolution, String> {
    Ok(resolve_track_language_selection(
        &tracks,
        preferred_language.as_deref(),
        selected_track_id,
    ))
}

#[command]
pub async fn save_selected_playback_language_preference(
    app: AppHandle,
    preference_kind: PlaybackLanguagePreferenceKind,
    track: Option<TrackLanguageCandidate>,
    subtitles_off: Option<bool>,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let mut preferences = read_playback_language_preferences_from_store(&store);

    let Some(selected_language) = infer_selected_playback_language_preference(
        preference_kind,
        track.as_ref(),
        subtitles_off.unwrap_or(false),
    ) else {
        return Ok(preferences);
    };

    match preference_kind {
        PlaybackLanguagePreferenceKind::Audio => {
            preferences.preferred_audio_language = Some(selected_language);
        }
        PlaybackLanguagePreferenceKind::Sub => {
            preferences.preferred_subtitle_language = Some(selected_language);
        }
    }

    persist_playback_language_preferences(&store, &preferences)?;
    Ok(preferences)
}

#[command]
pub async fn save_playback_language_preference_outcome_from_tracks(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    media_id: String,
    media_type: String,
    audio_track: Option<TrackLanguageCandidate>,
    subtitle_track: Option<TrackLanguageCandidate>,
    subtitles_off: Option<bool>,
) -> Result<(), String> {
    let media_id = normalize_non_empty(&media_id)
        .ok_or_else(|| "Media ID is required for playback preference outcomes.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&media_id))
        .ok_or_else(|| "Invalid media type for playback preference outcomes.".to_string())?;

    let preferred_audio_language = infer_track_preferred_language_candidate(audio_track.as_ref());
    let preferred_subtitle_language = infer_selected_playback_language_preference(
        PlaybackLanguagePreferenceKind::Sub,
        subtitle_track.as_ref(),
        subtitles_off.unwrap_or(false),
    );

    if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
        return Ok(());
    }

    playback_state.record_playback_language_preference_outcome(
        &app,
        &media_id,
        &media_type,
        preferred_audio_language,
        preferred_subtitle_language,
        now_unix_millis(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        infer_selected_playback_language_preference, sanitize_language_pref,
        PlaybackLanguagePreferenceKind,
    };
    use crate::commands::language::TrackLanguageCandidate;

    #[test]
    fn sanitize_language_pref_canonicalizes_known_aliases() {
        assert_eq!(
            sanitize_language_pref(Some("English".to_string()), false).as_deref(),
            Some("en")
        );
        assert_eq!(
            sanitize_language_pref(Some("jpn".to_string()), true).as_deref(),
            Some("ja")
        );
        assert_eq!(
            sanitize_language_pref(Some("pt-BR".to_string()), false).as_deref(),
            Some("pt")
        );
    }

    #[test]
    fn sanitize_language_pref_preserves_subtitle_off() {
        assert_eq!(
            sanitize_language_pref(Some("off".to_string()), true).as_deref(),
            Some("off")
        );
        assert_eq!(sanitize_language_pref(Some("off".to_string()), false), None);
    }

    #[test]
    fn sanitize_language_pref_drops_empty_or_unknown_values() {
        assert_eq!(sanitize_language_pref(Some("   ".to_string()), false), None);
        assert_eq!(
            sanitize_language_pref(Some("commentary".to_string()), true),
            None
        );
    }

    #[test]
    fn infer_selected_playback_language_preference_keeps_subtitles_off() {
        assert_eq!(
            infer_selected_playback_language_preference(
                PlaybackLanguagePreferenceKind::Sub,
                None,
                true,
            )
            .as_deref(),
            Some("off")
        );
    }

    #[test]
    fn infer_selected_playback_language_preference_reads_track_metadata() {
        let track = TrackLanguageCandidate {
            id: 1,
            lang: Some("eng".to_string()),
            title: Some("English Commentary".to_string()),
            default_track: false,
            forced: false,
            hearing_impaired: false,
        };

        assert_eq!(
            infer_selected_playback_language_preference(
                PlaybackLanguagePreferenceKind::Audio,
                Some(&track),
                false,
            )
            .as_deref(),
            Some("en")
        );
    }
}
