use super::streaming_helpers::{find_best_matching_file, infer_stream_mime, normalize_http_url};
use crate::operational_log::{field, log_operational_event, OperationalLogLevel};
use crate::providers::realdebrid::{InstantAvailabilityResponse, RealDebrid};
use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;

const RD_TRANSIENT_RETRY_DELAY_MS: u64 = 900;

/// Shared HTTP client for following redirect chains on direct stream URLs.
/// Re-used across calls to avoid per-request TLS handshake overhead.
static REDIRECT_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

#[derive(Debug, Serialize)]
pub struct ResolvedStream {
    pub url: String,
    pub is_web_friendly: bool,
    pub format: String,
}

#[derive(Debug, Serialize)]
pub struct BestResolvedStream {
    pub url: String,
    pub is_web_friendly: bool,
    pub format: String,
    pub used_fallback: bool,
    pub source_name: Option<String>,
    pub stream_family: Option<String>,
}

async fn resolve_final_direct_url(direct_url: &str) -> Result<String, String> {
    let client = &*REDIRECT_CLIENT;
    let head_error = match client.head(direct_url).send().await {
        Ok(resp) if resp.status().is_success() || resp.status().is_redirection() => {
            return Ok(resp.url().to_string());
        }
        Ok(resp) => format!("HEAD probe returned HTTP {}", resp.status().as_u16()),
        Err(error) => format!("HEAD probe failed: {}", error),
    };

    match client
        .get(direct_url)
        .header("Range", "bytes=0-0")
        .send()
        .await
    {
        Ok(resp)
            if resp.status().is_success()
                || resp.status().is_redirection()
                || resp.status() == reqwest::StatusCode::PARTIAL_CONTENT =>
        {
            Ok(resp.url().to_string())
        }
        Ok(resp) => Err(format!(
            "{}; range probe returned HTTP {}",
            head_error,
            resp.status().as_u16()
        )),
        Err(error) => Err(format!("{}; range probe failed: {}", head_error, error)),
    }
}

pub(crate) fn is_auth_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("real-debrid auth error") || lower.contains("realdebrid auth error")
}

pub(crate) fn is_missing_debrid_config_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("requires a configured debrid provider")
        || lower.contains("requires debrid or a direct-link addon")
        || lower.contains("no debrid token configured")
        || lower.contains("no real-debrid token")
}

pub(crate) fn missing_debrid_provider_message() -> &'static str {
    "This stream requires a configured debrid provider or an addon that returns direct playback URLs."
}

fn is_transient_rd_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("connection refused")
        || lower.contains("temporary")
        || lower.contains("dns")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("500")
        || lower.contains("429")
}

async fn run_with_transient_retry<T, F, Fut>(
    _operation_name: &str,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match operation().await {
        Ok(value) => Ok(value),
        Err(first_error) => {
            if !is_transient_rd_error(&first_error) {
                return Err(first_error);
            }

            log_operational_event(
                OperationalLogLevel::Warn,
                "stream-resolver",
                _operation_name,
                "transient-retry",
                &[field("error", &first_error)],
            );

            tokio::time::sleep(Duration::from_millis(RD_TRANSIENT_RETRY_DELAY_MS)).await;
            operation().await
        }
    }
}

fn is_disabled_rd_availability(message: &str) -> bool {
    message.contains("disabled_endpoint") || message.contains("\"error_code\": 37")
}

fn is_rd_processing_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "queued" | "downloading" | "magnet_conversion" | "waiting_files_selection"
    )
}

fn has_rd_variants(availability: &InstantAvailabilityResponse, hash: &str) -> bool {
    availability
        .items
        .get(hash)
        .and_then(|variants| variants.get("rd"))
        .and_then(|rd_variants| rd_variants.as_array())
        .is_some_and(|arr| !arr.is_empty())
}

pub(crate) struct ResolveStreamParams {
    pub(crate) magnet: String,
    pub(crate) info_hash: Option<String>,
    pub(crate) file_idx: Option<usize>,
    pub(crate) season: Option<u32>,
    pub(crate) episode: Option<u32>,
    pub(crate) url: Option<String>,
}

pub(crate) async fn resolve_stream_inner(
    provider: &RealDebrid,
    token: Option<&str>,
    params: ResolveStreamParams,
) -> Result<ResolvedStream, String> {
    let ResolveStreamParams {
        magnet,
        info_hash,
        file_idx,
        season,
        episode,
        url,
    } = params;

    if let Some(direct_url) = url.and_then(|value| normalize_http_url(&value)) {
        let final_url = resolve_final_direct_url(&direct_url)
            .await
            .map_err(|error| format!("Direct stream validation failed: {}", error))?;

        return Ok(ResolvedStream {
            format: infer_stream_mime(&final_url).to_string(),
            is_web_friendly: true,
            url: final_url,
        });
    }

    let token = token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| missing_debrid_provider_message().to_string())?;

    if let Some(hash) = &info_hash {
        let availability_res = run_with_transient_retry("availability check", || async {
            provider
                .check_availability(&token, vec![hash.clone()])
                .await
                .map_err(|e| e.to_string())
        })
        .await;

        match availability_res {
            Ok(availability) => {
                if !has_rd_variants(&availability, hash) {
                    return Err(
                        "Stream not cached on Real-Debrid (Instant availability failed)."
                            .to_string(),
                    );
                }
            }
            Err(error) => {
                if is_disabled_rd_availability(&error) {
                    log_operational_event(
                        OperationalLogLevel::Warn,
                        "stream-resolver",
                        "availability-check",
                        "disabled-endpoint",
                        &[field("hash", hash), field("error", &error)],
                    );
                } else if is_auth_error(&error) {
                    return Err(format!("Real-Debrid Auth Error: {}", error));
                } else if is_transient_rd_error(&error) {
                    return Err(
                        "Temporary Real-Debrid availability issue. Please retry in a moment."
                            .to_string(),
                    );
                } else {
                    return Err(format!("Availability Check Error: {}", error));
                }
            }
        }
    }

    let add_res = run_with_transient_retry("add magnet", || async {
        provider
            .add_magnet(&token, &magnet)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|error| {
        if is_auth_error(&error) {
            format!("Real-Debrid Auth Error during add magnet: {}", error)
        } else if is_transient_rd_error(&error) {
            format!("Temporary Real-Debrid add-magnet failure: {}", error)
        } else {
            format!("Failed to add magnet to Real-Debrid: {}", error)
        }
    })?;
    let torrent_id = add_res.id;

    let info = run_with_transient_retry("get torrent info", || async {
        provider
            .get_torrent_info(&token, &torrent_id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|error| {
        if is_auth_error(&error) {
            format!(
                "Real-Debrid Auth Error while fetching torrent info: {}",
                error
            )
        } else if is_transient_rd_error(&error) {
            "Temporary Real-Debrid error while loading torrent info. Please retry.".to_string()
        } else {
            format!("Failed to get torrent info: {}", error)
        }
    })?;

    let target_file_idx = if let Some(idx) = file_idx {
        if idx < info.files.len() {
            idx
        } else {
            find_best_matching_file(&info.files, season, episode)
        }
    } else {
        find_best_matching_file(&info.files, season, episode)
    };

    if target_file_idx >= info.files.len() {
        return Err("No suitable file found in torrent.".to_string());
    }

    let target_file_id = info.files[target_file_idx].id.to_string();

    run_with_transient_retry("select files", || async {
        provider
            .select_files(&token, &torrent_id, &target_file_id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|error| {
        if is_auth_error(&error) {
            format!("Real-Debrid Auth Error during file selection: {}", error)
        } else if is_transient_rd_error(&error) {
            "Temporary Real-Debrid error while selecting files. Please retry.".to_string()
        } else {
            format!("Failed to select files: {}", error)
        }
    })?;

    tokio::time::sleep(Duration::from_millis(1200)).await;

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(30);
    let mut transient_poll_retry_used = false;
    let mut poll_attempts: u32 = 0;

    let links = loop {
        if start.elapsed() > timeout {
            let info = provider
                .get_torrent_info(&token, &torrent_id)
                .await
                .unwrap_or(info);
            if is_rd_processing_status(&info.status) {
                log_operational_event(
                    OperationalLogLevel::Warn,
                    "stream-resolver",
                    "wait-for-links",
                    "processing-timeout",
                    &[
                        field("torrent_id", &torrent_id),
                        field("status", &info.status),
                    ],
                );
                return Err("Torrent is not cached and is currently downloading on Real-Debrid. Please try again later.".to_string());
            }
            log_operational_event(
                OperationalLogLevel::Warn,
                "stream-resolver",
                "wait-for-links",
                "timeout",
                &[
                    field("torrent_id", &torrent_id),
                    field("status", &info.status),
                ],
            );
            return Err("Timeout waiting for Real-Debrid to process links.".to_string());
        }

        let info = match provider.get_torrent_info(&token, &torrent_id).await {
            Ok(value) => value,
            Err(error) => {
                let error = error.to_string();
                log_operational_event(
                    OperationalLogLevel::Warn,
                    "stream-resolver",
                    "poll-torrent-info",
                    "failed",
                    &[field("torrent_id", &torrent_id), field("error", &error)],
                );

                if is_auth_error(&error) {
                    return Err(format!(
                        "Real-Debrid Auth Error while polling torrent info: {}",
                        error
                    ));
                }

                if is_transient_rd_error(&error) {
                    if !transient_poll_retry_used {
                        transient_poll_retry_used = true;
                        tokio::time::sleep(Duration::from_millis(RD_TRANSIENT_RETRY_DELAY_MS))
                            .await;
                        continue;
                    }

                    return Err(
                        "Temporary Real-Debrid network/server issue while waiting for links. Please retry."
                            .to_string(),
                    );
                }

                return Err(format!(
                    "Failed while waiting for Real-Debrid links: {}",
                    error
                ));
            }
        };

        let status = info.status.trim().to_ascii_lowercase();

        if status == "downloaded" && !info.links.is_empty() {
            break info.links;
        } else if status == "error" || status == "dead" {
            return Err(format!(
                "Torrent failed on Real-Debrid (Status: {})",
                info.status
            ));
        } else if status == "magnet_error" {
            return Err("Real-Debrid could not process this magnet link.".to_string());
        }

        poll_attempts = poll_attempts.saturating_add(1);
        let poll_delay = if poll_attempts <= 3 {
            std::time::Duration::from_millis(500)
        } else {
            std::time::Duration::from_secs(1)
        };
        tokio::time::sleep(poll_delay).await;
    };

    if links.is_empty() {
        return Err("No links returned from Real-Debrid.".to_string());
    }

    let target_link = &links[0];

    let unrestrict = provider
        .unrestrict_link(&token, target_link)
        .await
        .map_err(|e| format!("Failed to unrestrict link: {}", e))?;

    let filename_lower = unrestrict.filename.to_lowercase();
    let has_problematic_codec = filename_lower.contains("hevc")
        || filename_lower.contains("x265")
        || filename_lower.contains("h265")
        || filename_lower.contains("10bit")
        || filename_lower.contains("hdr")
        || filename_lower.contains("dv")
        || filename_lower.contains("dolby vision")
        || filename_lower.contains("atmos")
        || filename_lower.contains("dts");

    let is_web_friendly = (unrestrict.mime_type.contains("mp4")
        || unrestrict.mime_type.contains("webm")
        || unrestrict.mime_type.contains("ogg")
        || filename_lower.ends_with(".mp4"))
        && !has_problematic_codec;

    Ok(ResolvedStream {
        url: unrestrict.link,
        is_web_friendly,
        format: unrestrict.mime_type,
    })
}
