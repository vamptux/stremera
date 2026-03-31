use super::config_store::get_trimmed_store_string;
use super::{
    normalize_non_empty, normalize_stream_media_type, now_unix_millis,
    playback_state::PlaybackStateService, PlaybackLanguagePreferences, SETTINGS_STORE_FILE,
};
use serde_json::json;
use tauri::{command, AppHandle, State};
use tauri_plugin_store::StoreExt;

fn canonicalize_language_pref_token(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "en" | "eng" | "english" => Some("en"),
        "ja" | "jpn" | "japanese" => Some("ja"),
        "es" | "spa" | "spanish" => Some("es"),
        "fr" | "fra" | "fre" | "french" => Some("fr"),
        "de" | "deu" | "ger" | "german" => Some("de"),
        "it" | "ita" | "italian" => Some("it"),
        "pt" | "por" | "portuguese" => Some("pt"),
        "ko" | "kor" | "korean" => Some("ko"),
        "zh" | "zho" | "chi" | "chinese" => Some("zh"),
        _ => None,
    }
}

pub(crate) fn sanitize_language_pref(value: Option<String>, allow_off: bool) -> Option<String> {
    let normalized = value
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .filter(|candidate| !candidate.is_empty())?;

    if allow_off && normalized == "off" {
        return Some(normalized);
    }

    let primary = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .find(|segment| !segment.is_empty())
        .unwrap_or(normalized.as_str());

    canonicalize_language_pref_token(primary).map(str::to_string)
}

#[command]
pub async fn save_playback_language_preferences(
    app: AppHandle,
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let audio = sanitize_language_pref(preferred_audio_language, false);
    let subtitle = sanitize_language_pref(preferred_subtitle_language, true);

    if let Some(value) = audio.as_ref() {
        store.set("preferred_audio_language", json!(value));
    } else {
        store.delete("preferred_audio_language");
    }

    if let Some(value) = subtitle.as_ref() {
        store.set("preferred_subtitle_language", json!(value));
    } else {
        store.delete("preferred_subtitle_language");
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(PlaybackLanguagePreferences {
        preferred_audio_language: audio,
        preferred_subtitle_language: subtitle,
    })
}

#[command]
pub async fn get_playback_language_preferences(
    app: AppHandle,
) -> Result<PlaybackLanguagePreferences, String> {
    let store = app.store(SETTINGS_STORE_FILE).map_err(|e| e.to_string())?;
    let preferred_audio_language = sanitize_language_pref(
        get_trimmed_store_string(&store, "preferred_audio_language"),
        false,
    );
    let preferred_subtitle_language = sanitize_language_pref(
        get_trimmed_store_string(&store, "preferred_subtitle_language"),
        true,
    );

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
        sanitize_language_pref(preferred_audio_language, false),
        sanitize_language_pref(preferred_subtitle_language, true),
        now_unix_millis(),
    )
}

#[cfg(test)]
mod tests {
    use super::sanitize_language_pref;

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
}
