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
    let stream_lookup_id = next_episode
        .imdb_id
        .clone()
        .unwrap_or_else(|| fallback_lookup_id.to_string());
    let stream_season = next_episode.imdb_season.unwrap_or(next_episode.season);
    let stream_episode = next_episode.imdb_episode.unwrap_or(next_episode.episode);
    let absolute_season = next_episode.season;
    let absolute_episode = next_episode.episode;
    let aniskip_episode = next_episode.imdb_episode.unwrap_or(next_episode.episode);
    let lookup_key = format!(
        "{}:{}:{}:{}:{}",
        media_type, stream_lookup_id, stream_season, stream_episode, absolute_episode
    );

    Some(NextPlaybackPlan {
        canonical: CanonicalEpisodeIdentity {
            title: next_episode.title.clone(),
            season: absolute_season,
            episode: absolute_episode,
        },
        source: SourceEpisodeCoordinates {
            lookup_id: stream_lookup_id,
            season: stream_season,
            episode: stream_episode,
            aniskip_episode,
        },
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
            overview: None,
            thumbnail: None,
            imdb_id: Some("tt123".to_string()),
            imdb_season: Some(season),
            imdb_episode: Some(episode),
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
}