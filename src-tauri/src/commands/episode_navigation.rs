use crate::providers::Episode;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedPlaybackStream {
    pub url: String,
    pub format: String,
    pub source_name: Option<String>,
    pub stream_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanonicalEpisodeIdentity {
    pub title: Option<String>,
    pub season: u32,
    pub episode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceEpisodeCoordinates {
    pub lookup_id: String,
    pub season: u32,
    pub episode: u32,
    pub aniskip_episode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NextPlaybackPlan {
    pub canonical: CanonicalEpisodeIdentity,
    pub source: SourceEpisodeCoordinates,
    pub lookup_key: String,
    pub primary_stream: Option<PreparedPlaybackStream>,
    pub backup_stream: Option<PreparedPlaybackStream>,
}

pub(crate) fn build_source_episode_coordinates(
    episode: &Episode,
    fallback_lookup_id: &str,
) -> SourceEpisodeCoordinates {
    SourceEpisodeCoordinates {
        lookup_id: episode
            .stream_lookup_id
            .clone()
            .or_else(|| episode.imdb_id.clone())
            .unwrap_or_else(|| fallback_lookup_id.to_string()),
        season: episode
            .stream_season
            .or(episode.imdb_season)
            .unwrap_or(episode.season),
        episode: episode
            .stream_episode
            .or(episode.imdb_episode)
            .unwrap_or(episode.episode),
        aniskip_episode: episode
            .aniskip_episode
            .or(episode.stream_episode)
            .or(episode.imdb_episode)
            .unwrap_or(episode.episode),
    }
}

pub(crate) fn build_episode_lookup_key(
    media_type: &str,
    source: &SourceEpisodeCoordinates,
    absolute_episode: u32,
) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        media_type, source.lookup_id, source.season, source.episode, absolute_episode
    )
}

fn find_next_episode_candidate(
    episodes: &[Episode],
    current_season: u32,
    current_episode: u32,
) -> Option<Episode> {
    let mut ordered = episodes.to_vec();
    ordered.sort_by(|left, right| {
        left.season
            .cmp(&right.season)
            .then_with(|| left.episode.cmp(&right.episode))
    });

    let exact_index = ordered
        .iter()
        .position(|episode| episode.season == current_season && episode.episode == current_episode);

    if let Some(index) = exact_index {
        return ordered.get(index + 1).cloned();
    }

    ordered
        .iter()
        .find(|episode| episode.season == current_season && episode.episode > current_episode)
        .cloned()
        .or_else(|| {
            ordered
                .iter()
                .find(|episode| episode.season > current_season)
                .cloned()
        })
}

pub(crate) fn build_next_playback_plan(
    episodes: &[Episode],
    current_season: u32,
    current_episode: u32,
    media_type: &str,
    fallback_lookup_id: &str,
) -> Option<NextPlaybackPlan> {
    let next_episode = find_next_episode_candidate(episodes, current_season, current_episode)?;
    let source = build_source_episode_coordinates(&next_episode, fallback_lookup_id);
    let absolute_season = next_episode.season;
    let absolute_episode = next_episode.episode;
    let lookup_key = build_episode_lookup_key(media_type, &source, absolute_episode);

    Some(NextPlaybackPlan {
        canonical: CanonicalEpisodeIdentity {
            title: next_episode.title.clone(),
            season: absolute_season,
            episode: absolute_episode,
        },
        source,
        lookup_key,
        primary_stream: None,
        backup_stream: None,
    })
}

#[cfg(test)]
mod tests {
    use super::build_next_playback_plan;
    use crate::providers::Episode;

    fn episode(season: u32, episode: u32) -> Episode {
        Episode {
            id: format!("{}:{}", season, episode),
            title: Some(format!("Episode {}", episode)),
            season,
            episode,
            released: None,
            release_date: None,
            overview: None,
            thumbnail: None,
            imdb_id: Some("tt123".to_string()),
            imdb_season: Some(season),
            imdb_episode: Some(episode),
            stream_lookup_id: None,
            stream_season: None,
            stream_episode: None,
            aniskip_episode: None,
        }
    }

    #[test]
    fn plan_selects_next_episode_in_order() {
        let episodes = vec![episode(1, 1), episode(1, 2), episode(1, 3)];
        let plan = build_next_playback_plan(&episodes, 1, 2, "series", "tt123")
            .expect("next playback plan");

        assert_eq!(plan.canonical.episode, 3);
        assert_eq!(plan.source.episode, 3);
    }

    #[test]
    fn plan_prefers_backend_normalized_episode_coordinates() {
        let mut episodes = vec![episode(1, 1), episode(1, 2)];
        episodes[1].stream_lookup_id = Some("tt999".to_string());
        episodes[1].stream_season = Some(4);
        episodes[1].stream_episode = Some(12);
        episodes[1].aniskip_episode = Some(13);

        let plan = build_next_playback_plan(&episodes, 1, 1, "anime", "tt123")
            .expect("next playback plan");

        assert_eq!(plan.source.lookup_id, "tt999");
        assert_eq!(plan.source.season, 4);
        assert_eq!(plan.source.episode, 12);
        assert_eq!(plan.source.aniskip_episode, 13);
    }
}
