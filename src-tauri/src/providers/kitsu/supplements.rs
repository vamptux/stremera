use super::{
    Kitsu, ANIME_CHARACTER_LIMIT, ANIME_PRODUCTION_LIMIT, ANIME_STAFF_LIMIT,
    ANIME_STREAMING_PLATFORM_LIMIT, RELATION_LIMIT,
};
use crate::providers::{
    normalize_media_year, AnimeCharacterProfile, AnimeProductionCompanyProfile, AnimeStaffProfile,
    AnimeStreamingPlatformProfile, AnimeSupplementalMetadata, MediaItem,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) async fn get_anime_supplemental_metadata(
    kitsu: &Kitsu,
    id: &str,
) -> Result<AnimeSupplementalMetadata, String> {
    let numeric_id = id.strip_prefix("kitsu:").unwrap_or(id).trim();
    if numeric_id.is_empty() {
        return Err("Anime ID is required for Kitsu metadata.".to_string());
    }

    let (characters_result, staff_result, productions_result, platforms_result) = tokio::join!(
        fetch_anime_characters(kitsu, numeric_id),
        fetch_anime_staff(kitsu, numeric_id),
        fetch_anime_productions(kitsu, numeric_id),
        fetch_anime_streaming_platforms(kitsu, numeric_id),
    );

    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let characters = match characters_result {
        Ok(characters) => characters,
        Err(error) => {
            errors.push(error);
            warnings.push(Kitsu::supplemental_warning("Character"));
            Vec::new()
        }
    };
    let staff = match staff_result {
        Ok(staff) => staff,
        Err(error) => {
            errors.push(error);
            warnings.push(Kitsu::supplemental_warning("Staff"));
            Vec::new()
        }
    };
    let productions = match productions_result {
        Ok(productions) => productions,
        Err(error) => {
            errors.push(error);
            warnings.push(Kitsu::supplemental_warning("Studio and producer"));
            Vec::new()
        }
    };
    let platforms = match platforms_result {
        Ok(platforms) => platforms,
        Err(error) => {
            errors.push(error);
            warnings.push(Kitsu::supplemental_warning("Streaming platform"));
            Vec::new()
        }
    };

    if characters.is_empty() && staff.is_empty() && productions.is_empty() && platforms.is_empty() {
        if let Some(error) = errors.into_iter().next() {
            return Err(error);
        }
    }

    Ok(AnimeSupplementalMetadata {
        characters,
        staff,
        productions,
        platforms,
        warnings,
    })
}

async fn fetch_anime_characters(
    kitsu: &Kitsu,
    kitsu_id: &str,
) -> Result<Vec<AnimeCharacterProfile>, String> {
    let url = format!(
        "https://kitsu.io/api/edge/anime/{}/characters?page[limit]={}&include=character",
        kitsu_id, ANIME_CHARACTER_LIMIT
    );
    let body = kitsu.fetch_edge_value(&url).await?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let included = body
        .get("included")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let included_characters = included
        .into_iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("characters"))
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.to_string();
            Some((id, entry))
        })
        .collect::<HashMap<_, _>>();

    let mut characters = Vec::new();
    let mut seen_character_ids = HashSet::new();

    for relationship in data {
        let Some(character_id) = relationship
            .pointer("/relationships/character/data/id")
            .and_then(Value::as_str)
        else {
            continue;
        };

        if !seen_character_ids.insert(character_id.to_string()) {
            continue;
        }

        let Some(character) = included_characters.get(character_id) else {
            continue;
        };

        let Some(name) = Kitsu::extract_value_string(character, "/attributes/canonicalName")
            .or_else(|| Kitsu::extract_value_string(character, "/attributes/name"))
        else {
            continue;
        };

        characters.push(AnimeCharacterProfile {
            name,
            role: Kitsu::extract_value_string(&relationship, "/attributes/role")
                .map(|role| Kitsu::title_case_label(&role)),
            image: Kitsu::extract_image_url(character, "image"),
            description: Kitsu::extract_value_string(character, "/attributes/description"),
        });
    }

    characters.sort_by(|left, right| {
        Kitsu::character_role_priority(right.role.as_deref())
            .cmp(&Kitsu::character_role_priority(left.role.as_deref()))
            .then_with(|| left.name.cmp(&right.name))
    });
    characters.truncate(ANIME_CHARACTER_LIMIT);

    Ok(characters)
}

async fn fetch_anime_staff(
    kitsu: &Kitsu,
    kitsu_id: &str,
) -> Result<Vec<AnimeStaffProfile>, String> {
    let url = format!(
        "https://kitsu.io/api/edge/anime/{}/anime-staff?page[limit]={}&include=person",
        kitsu_id, ANIME_STAFF_LIMIT
    );
    let body = kitsu.fetch_edge_value(&url).await?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let included = body
        .get("included")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let included_people = included
        .into_iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("people"))
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.to_string();
            Some((id, entry))
        })
        .collect::<HashMap<_, _>>();

    let mut merged_staff: HashMap<String, AnimeStaffProfile> = HashMap::new();

    for relationship in data {
        let Some(person_id) = relationship
            .pointer("/relationships/person/data/id")
            .and_then(Value::as_str)
        else {
            continue;
        };

        let Some(person) = included_people.get(person_id) else {
            continue;
        };

        let Some(name) = Kitsu::extract_value_string(person, "/attributes/name") else {
            continue;
        };

        let staff_entry = merged_staff
            .entry(person_id.to_string())
            .or_insert_with(|| AnimeStaffProfile {
                name,
                roles: Vec::new(),
                image: Kitsu::extract_image_url(person, "image"),
                description: Kitsu::extract_value_string(person, "/attributes/description"),
            });

        if let Some(raw_role) = Kitsu::extract_value_string(&relationship, "/attributes/role") {
            for role in raw_role
                .split(',')
                .filter_map(Kitsu::normalize_text)
                .map(|role| Kitsu::title_case_label(&role))
            {
                if !staff_entry.roles.iter().any(|existing| existing == &role) {
                    staff_entry.roles.push(role);
                }
            }
        }
    }

    let mut staff = merged_staff.into_values().collect::<Vec<_>>();
    for entry in &mut staff {
        entry.roles.sort_by(|left, right| {
            Kitsu::staff_role_priority(right)
                .cmp(&Kitsu::staff_role_priority(left))
                .then_with(|| left.cmp(right))
        });
    }

    staff.sort_by(|left, right| {
        let left_priority = left
            .roles
            .iter()
            .map(|role| Kitsu::staff_role_priority(role))
            .max()
            .unwrap_or(0);
        let right_priority = right
            .roles
            .iter()
            .map(|role| Kitsu::staff_role_priority(role))
            .max()
            .unwrap_or(0);

        right_priority
            .cmp(&left_priority)
            .then_with(|| left.name.cmp(&right.name))
    });
    staff.truncate(ANIME_STAFF_LIMIT);

    Ok(staff)
}

async fn fetch_anime_productions(
    kitsu: &Kitsu,
    kitsu_id: &str,
) -> Result<Vec<AnimeProductionCompanyProfile>, String> {
    let url = format!(
        "https://kitsu.io/api/edge/anime/{}/productions?page[limit]={}&include=producer",
        kitsu_id, ANIME_PRODUCTION_LIMIT
    );
    let body = kitsu.fetch_edge_value(&url).await?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let included = body
        .get("included")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let included_producers = included
        .into_iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("producers"))
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.to_string();
            Some((id, entry))
        })
        .collect::<HashMap<_, _>>();

    let mut merged_productions: HashMap<String, AnimeProductionCompanyProfile> = HashMap::new();

    for relationship in data {
        let Some(producer_id) = relationship
            .pointer("/relationships/producer/data/id")
            .and_then(Value::as_str)
        else {
            continue;
        };

        let Some(producer) = included_producers.get(producer_id) else {
            continue;
        };

        let Some(name) = Kitsu::extract_value_string(producer, "/attributes/name") else {
            continue;
        };

        let production_entry = merged_productions
            .entry(producer_id.to_string())
            .or_insert_with(|| AnimeProductionCompanyProfile {
                name,
                roles: Vec::new(),
                logo: Kitsu::extract_image_url(producer, "logo")
                    .or_else(|| Kitsu::extract_image_url(producer, "image")),
                description: Kitsu::extract_value_string(producer, "/attributes/description"),
            });

        if let Some(raw_role) = Kitsu::extract_value_string(&relationship, "/attributes/role")
            .or_else(|| Kitsu::extract_value_string(&relationship, "/attributes/producerType"))
        {
            for role in raw_role
                .split(',')
                .filter_map(Kitsu::normalize_text)
                .map(|role| Kitsu::title_case_label(&role))
            {
                if !production_entry
                    .roles
                    .iter()
                    .any(|existing| existing == &role)
                {
                    production_entry.roles.push(role);
                }
            }
        }
    }

    let mut productions = merged_productions.into_values().collect::<Vec<_>>();
    for entry in &mut productions {
        entry.roles.sort_by(|left, right| {
            Kitsu::production_role_priority(right)
                .cmp(&Kitsu::production_role_priority(left))
                .then_with(|| left.cmp(right))
        });
    }

    productions.sort_by(|left, right| {
        let left_priority = left
            .roles
            .iter()
            .map(|role| Kitsu::production_role_priority(role))
            .max()
            .unwrap_or(0);
        let right_priority = right
            .roles
            .iter()
            .map(|role| Kitsu::production_role_priority(role))
            .max()
            .unwrap_or(0);

        right_priority
            .cmp(&left_priority)
            .then_with(|| left.name.cmp(&right.name))
    });
    productions.truncate(ANIME_PRODUCTION_LIMIT);

    Ok(productions)
}

async fn fetch_anime_streaming_platforms(
    kitsu: &Kitsu,
    kitsu_id: &str,
) -> Result<Vec<AnimeStreamingPlatformProfile>, String> {
    let url = format!(
        "https://kitsu.io/api/edge/anime/{}/streaming-links?page[limit]=20&include=streamer",
        kitsu_id
    );
    let body = kitsu.fetch_edge_value(&url).await?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let included = body
        .get("included")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let included_streamers = included
        .into_iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("streamers"))
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.to_string();
            Some((id, entry))
        })
        .collect::<HashMap<_, _>>();

    let mut merged_platforms: HashMap<String, AnimeStreamingPlatformProfile> = HashMap::new();
    let mut platform_link_counts: HashMap<String, usize> = HashMap::new();

    for streaming_link in data {
        let Some(streamer_id) = streaming_link
            .pointer("/relationships/streamer/data/id")
            .and_then(Value::as_str)
        else {
            continue;
        };

        let Some(streamer) = included_streamers.get(streamer_id) else {
            continue;
        };

        let Some(name) = Kitsu::extract_value_string(streamer, "/attributes/siteName") else {
            continue;
        };

        let Some(link_url) = Kitsu::extract_value_string(&streaming_link, "/attributes/url") else {
            continue;
        };

        if reqwest::Url::parse(&link_url).is_err() {
            continue;
        }

        let key = streamer_id.to_string();
        let entry =
            merged_platforms
                .entry(key.clone())
                .or_insert_with(|| AnimeStreamingPlatformProfile {
                    name,
                    url: link_url.clone(),
                    logo: Kitsu::extract_value_string(streamer, "/attributes/logo"),
                    sub_languages: Vec::new(),
                    dub_languages: Vec::new(),
                });

        if entry.logo.is_none() {
            entry.logo = Kitsu::extract_value_string(streamer, "/attributes/logo");
        }
        if Kitsu::should_replace_platform_url(&entry.url, &link_url) {
            entry.url = link_url.clone();
        }

        for language in Kitsu::extract_language_labels(&streaming_link, "/attributes/subs") {
            if !entry
                .sub_languages
                .iter()
                .any(|existing| existing == &language)
            {
                entry.sub_languages.push(language);
            }
        }
        for language in Kitsu::extract_language_labels(&streaming_link, "/attributes/dubs") {
            if !entry
                .dub_languages
                .iter()
                .any(|existing| existing == &language)
            {
                entry.dub_languages.push(language);
            }
        }

        *platform_link_counts.entry(key).or_insert(0) += 1;
    }

    let mut platforms = merged_platforms
        .into_iter()
        .map(|(key, mut platform)| {
            platform.sub_languages.sort();
            platform.dub_languages.sort();
            let link_count = platform_link_counts.get(&key).copied().unwrap_or(0);
            (link_count, platform)
        })
        .collect::<Vec<_>>();

    platforms.sort_by(|(left_count, left), (right_count, right)| {
        right_count
            .cmp(left_count)
            .then_with(|| {
                let right_signal = right.sub_languages.len() + right.dub_languages.len();
                let left_signal = left.sub_languages.len() + left.dub_languages.len();
                right_signal.cmp(&left_signal)
            })
            .then_with(|| left.name.cmp(&right.name))
    });
    platforms.truncate(ANIME_STREAMING_PLATFORM_LIMIT);

    Ok(platforms
        .into_iter()
        .map(|(_, platform)| platform)
        .collect())
}

pub(super) async fn fetch_relations(kitsu: &Kitsu, kitsu_id: &str) -> Option<Vec<MediaItem>> {
    let url = format!(
        "https://kitsu.io/api/edge/anime/{}/media-relationships?include=destination&page[limit]={}",
        kitsu_id, RELATION_LIMIT
    );

    let body = kitsu.fetch_edge_value(&url).await.ok()?;

    let relation_roles = body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let destination_id = entry
                .pointer("/relationships/destination/data/id")
                .and_then(Value::as_str)?;
            let role = Kitsu::extract_value_string(entry, "/attributes/role")?;
            Some((destination_id.to_string(), role))
        })
        .collect::<HashMap<_, _>>();

    let included = body.get("included")?.as_array()?;

    let relations: Vec<MediaItem> = included
        .iter()
        .filter_map(|item| {
            let attrs = item.get("attributes")?;
            let id = item.get("id")?.as_str()?;
            let type_ = item.get("type")?.as_str()?;

            if type_ != "anime" {
                return None;
            }

            let title = attrs
                .get("canonicalTitle")
                .and_then(Value::as_str)
                .unwrap_or("Unknown")
                .to_string();
            let poster = attrs
                .get("posterImage")
                .and_then(|image| image.get("original").or(image.get("large")))
                .and_then(Value::as_str)
                .map(str::to_string);

            let backdrop = attrs
                .get("coverImage")
                .and_then(|image| image.get("original").or(image.get("large")))
                .and_then(Value::as_str)
                .map(str::to_string);

            let description = attrs
                .get("synopsis")
                .and_then(Value::as_str)
                .map(str::to_string);
            let year = attrs
                .get("startDate")
                .and_then(Value::as_str)
                .map(str::to_string);

            Some(MediaItem {
                id: format!("kitsu:{}", id),
                title,
                poster,
                backdrop,
                logo: None,
                description,
                year: normalize_media_year(year, None),
                primary_year: None,
                display_year: None,
                type_: "series".to_string(),
                relation_role: relation_roles.get(id).cloned(),
                relation_context_label: None,
                relation_preferred_season: None,
            })
        })
        .take(RELATION_LIMIT)
        .collect();

    if relations.is_empty() {
        None
    } else {
        Some(relations)
    }
}
