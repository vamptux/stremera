use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

const RD_BASE_URL: &str = "https://api.real-debrid.com";

#[derive(Clone)]
pub struct RealDebrid {
    client: Client,
}

/// Adds Authorization header for compatibility with endpoints that require Bearer tokens.
fn add_auth_header(builder: RequestBuilder, token: &str) -> RequestBuilder {
    builder.header("Authorization", format!("Bearer {}", token))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: u64,
    pub username: String,
    pub email: String,
    pub points: u64,
    pub locale: String,
    pub avatar: String,
    pub r#type: String,
    pub premium: Option<u64>,
    pub expiration: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstantAvailabilityResponse {
    #[serde(flatten)]
    pub items: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AddMagnetResponse {
    pub id: String,
    pub uri: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TorrentInfo {
    pub id: String,
    pub filename: String,
    pub original_filename: String,
    pub hash: String,
    pub bytes: u64,
    pub original_bytes: u64,
    pub host: String,
    pub split: u64,
    pub progress: u64,
    pub status: String,
    pub added: String,
    pub files: Vec<TorrentFile>,
    pub links: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TorrentFile {
    pub id: u64,
    pub path: String,
    pub bytes: u64,
    pub selected: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnrestrictResponse {
    pub id: String,
    pub filename: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub filesize: u64,
    pub link: String,
}

impl RealDebrid {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }

    pub async fn get_user_info(&self, access_token: &str) -> Result<UserInfo, String> {
        let url = format!("{}/rest/1.0/user", RD_BASE_URL);
        let res = add_auth_header(self.client.get(&url), access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("User Info Error: {} - {}", status, body));
        }

        res.json::<UserInfo>().await.map_err(|e| e.to_string())
    }

    pub async fn check_availability(
        &self,
        access_token: &str,
        hashes: Vec<String>,
    ) -> Result<InstantAvailabilityResponse, String> {
        let url = format!(
            "{}/rest/1.0/torrents/instantAvailability/{}",
            RD_BASE_URL,
            hashes.join("/")
        );
        let res = add_auth_header(self.client.get(&url), access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Availability Error: {} - {}", status, body));
        }

        res.json::<InstantAvailabilityResponse>()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn add_magnet(
        &self,
        access_token: &str,
        magnet: &str,
    ) -> Result<AddMagnetResponse, String> {
        let url = format!("{}/rest/1.0/torrents/addMagnet", RD_BASE_URL);
        let res = add_auth_header(self.client.post(&url), access_token)
            .form(&[("magnet", magnet)])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Add Magnet Error: {} - {}", status, body));
        }

        res.json::<AddMagnetResponse>()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn select_files(
        &self,
        access_token: &str,
        id: &str,
        files: &str,
    ) -> Result<(), String> {
        let url = format!("{}/rest/1.0/torrents/selectFiles/{}", RD_BASE_URL, id);
        let res = add_auth_header(self.client.post(&url), access_token)
            .form(&[("files", files)])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Select Files Error: {} - {}", status, body));
        }
        Ok(())
    }

    pub async fn get_torrent_info(
        &self,
        access_token: &str,
        id: &str,
    ) -> Result<TorrentInfo, String> {
        let url = format!("{}/rest/1.0/torrents/info/{}", RD_BASE_URL, id);
        let res = add_auth_header(self.client.get(&url), access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Torrent Info Error: {} - {}", status, body));
        }

        res.json::<TorrentInfo>().await.map_err(|e| e.to_string())
    }

    pub async fn unrestrict_link(
        &self,
        access_token: &str,
        link: &str,
    ) -> Result<UnrestrictResponse, String> {
        let url = format!("{}/rest/1.0/unrestrict/link", RD_BASE_URL);
        let res = add_auth_header(self.client.post(&url), access_token)
            .form(&[("link", link)])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Unrestrict Error: {} - {}", status, body));
        }

        res.json::<UnrestrictResponse>()
            .await
            .map_err(|e| e.to_string())
    }
}

impl Default for RealDebrid {
    fn default() -> Self {
        Self::new()
    }
}
