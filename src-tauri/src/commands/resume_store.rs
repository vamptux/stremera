use crate::commands::WatchProgress;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use std::convert::TryFrom;
use std::path::Path;

const RESUME_DB_SCHEMA_VERSION: i32 = 1;
const MAX_RESUME_ROWS_PER_TITLE: usize = 12;

pub(crate) struct ResumeStore {
    connection: Connection,
}

impl ResumeStore {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path)
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;

        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA temp_store = MEMORY;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS watch_progress (
                    history_key TEXT PRIMARY KEY NOT NULL,
                    media_id TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    season INTEGER,
                    episode INTEGER,
                    absolute_season INTEGER,
                    absolute_episode INTEGER,
                    stream_season INTEGER,
                    stream_episode INTEGER,
                    aniskip_episode INTEGER,
                    position REAL NOT NULL,
                    duration REAL NOT NULL,
                    last_watched INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    poster TEXT,
                    backdrop TEXT,
                    last_stream_url TEXT,
                    last_stream_format TEXT,
                    last_stream_lookup_id TEXT,
                    last_stream_key TEXT,
                    source_name TEXT,
                    stream_family TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_watch_progress_title_recency
                    ON watch_progress(media_type, media_id, last_watched DESC, history_key DESC);

                PRAGMA user_version = 1;
                ",
            )
            .map_err(|error| format!("Failed to initialize playback resume database: {}", error))?;

        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("Failed to read playback resume schema version: {}", error))?;

        if version != RESUME_DB_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported playback resume schema version {}.",
                version
            ));
        }

        Ok(Self { connection })
    }

    pub(crate) fn upsert_progress(
        &mut self,
        key: &str,
        progress: &WatchProgress,
    ) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Failed to open playback resume transaction: {}", error))?;

        upsert_progress_tx(&transaction, key, progress)?;
        prune_title_history_tx(&transaction, &progress.type_, &progress.id)?;

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume save: {}", error))
    }

    pub(crate) fn load_entries(&mut self) -> Result<Vec<(String, WatchProgress)>, String> {
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT
                    history_key,
                    media_id,
                    media_type,
                    season,
                    episode,
                    absolute_season,
                    absolute_episode,
                    stream_season,
                    stream_episode,
                    aniskip_episode,
                    position,
                    duration,
                    last_watched,
                    title,
                    poster,
                    backdrop,
                    last_stream_url,
                    last_stream_format,
                    last_stream_lookup_id,
                    last_stream_key,
                    source_name,
                    stream_family
                FROM watch_progress
                ORDER BY last_watched DESC, history_key DESC
                ",
            )
            .map_err(|error| format!("Failed to prepare playback resume read: {}", error))?;

        let rows = statement
            .query_map([], read_watch_progress_row)
            .map_err(|error| format!("Failed to query playback resume rows: {}", error))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to decode playback resume rows: {}", error))
    }

    pub(crate) fn merge_entries(
        &mut self,
        entries: Vec<(String, WatchProgress)>,
    ) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }

        let transaction = self.connection.transaction().map_err(|error| {
            format!(
                "Failed to open playback resume merge transaction: {}",
                error
            )
        })?;
        let mut imported = 0usize;

        for (key, progress) in entries {
            let existing_last_watched = transaction
                .query_row(
                    "SELECT last_watched FROM watch_progress WHERE history_key = ?1",
                    params![key],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| {
                    format!("Failed to inspect existing playback resume row: {}", error)
                })?;

            if let Some(existing_last_watched) = existing_last_watched {
                if existing_last_watched >= to_sql_i64(progress.last_watched) {
                    continue;
                }
            }

            upsert_progress_tx(&transaction, &key, &progress)?;
            prune_title_history_tx(&transaction, &progress.type_, &progress.id)?;
            imported += 1;
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume merge: {}", error))?;

        Ok(imported)
    }

    pub(crate) fn get_entry(&mut self, key: &str) -> Result<Option<WatchProgress>, String> {
        self.connection
            .query_row(
                "
                SELECT
                    history_key,
                    media_id,
                    media_type,
                    season,
                    episode,
                    absolute_season,
                    absolute_episode,
                    stream_season,
                    stream_episode,
                    aniskip_episode,
                    position,
                    duration,
                    last_watched,
                    title,
                    poster,
                    backdrop,
                    last_stream_url,
                    last_stream_format,
                    last_stream_lookup_id,
                    last_stream_key,
                    source_name,
                    stream_family
                FROM watch_progress
                WHERE history_key = ?1
                ",
                params![key],
                read_watch_progress_row,
            )
            .optional()
            .map(|entry| entry.map(|(_, progress)| progress))
            .map_err(|error| format!("Failed to read playback resume entry: {}", error))
    }

    pub(crate) fn remove_keys(&mut self, keys: &[String]) -> Result<(), String> {
        if keys.is_empty() {
            return Ok(());
        }

        let transaction = self.connection.transaction().map_err(|error| {
            format!(
                "Failed to open playback resume delete transaction: {}",
                error
            )
        })?;

        {
            let mut statement = transaction
                .prepare("DELETE FROM watch_progress WHERE history_key = ?1")
                .map_err(|error| format!("Failed to prepare playback resume delete: {}", error))?;

            for key in keys {
                statement.execute(params![key]).map_err(|error| {
                    format!("Failed to delete playback resume entry: {}", error)
                })?;
            }
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume delete: {}", error))
    }

    pub(crate) fn clear(&mut self) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM watch_progress", [])
            .map_err(|error| format!("Failed to clear playback resume database: {}", error))?;

        self.connection
            .execute("VACUUM", [])
            .map_err(|error| format!("Failed to compact playback resume database: {}", error))?;

        Ok(())
    }

    pub(crate) fn clear_saved_stream_links(&mut self) -> Result<(), String> {
        self.connection
            .execute(
                "
                UPDATE watch_progress
                SET
                    last_stream_url = NULL,
                    last_stream_format = NULL,
                    last_stream_key = NULL
                WHERE
                    last_stream_url IS NOT NULL
                    OR last_stream_format IS NOT NULL
                    OR last_stream_key IS NOT NULL
                ",
                [],
            )
            .map_err(|error| format!("Failed to clear saved playback stream links: {}", error))?;

        Ok(())
    }
}

fn upsert_progress_tx(
    transaction: &Transaction<'_>,
    key: &str,
    progress: &WatchProgress,
) -> Result<(), String> {
    transaction
        .execute(
            "
            INSERT INTO watch_progress (
                history_key,
                media_id,
                media_type,
                season,
                episode,
                absolute_season,
                absolute_episode,
                stream_season,
                stream_episode,
                aniskip_episode,
                position,
                duration,
                last_watched,
                title,
                poster,
                backdrop,
                last_stream_url,
                last_stream_format,
                last_stream_lookup_id,
                last_stream_key,
                source_name,
                stream_family
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
            )
            ON CONFLICT(history_key) DO UPDATE SET
                media_id = excluded.media_id,
                media_type = excluded.media_type,
                season = excluded.season,
                episode = excluded.episode,
                absolute_season = excluded.absolute_season,
                absolute_episode = excluded.absolute_episode,
                stream_season = excluded.stream_season,
                stream_episode = excluded.stream_episode,
                aniskip_episode = excluded.aniskip_episode,
                position = excluded.position,
                duration = excluded.duration,
                last_watched = excluded.last_watched,
                title = excluded.title,
                poster = excluded.poster,
                backdrop = excluded.backdrop,
                last_stream_url = excluded.last_stream_url,
                last_stream_format = excluded.last_stream_format,
                last_stream_lookup_id = excluded.last_stream_lookup_id,
                last_stream_key = excluded.last_stream_key,
                source_name = excluded.source_name,
                stream_family = excluded.stream_family
            ",
            params![
                key,
                progress.id,
                progress.type_,
                to_sql_optional_u32(progress.season),
                to_sql_optional_u32(progress.episode),
                to_sql_optional_u32(progress.absolute_season),
                to_sql_optional_u32(progress.absolute_episode),
                to_sql_optional_u32(progress.stream_season),
                to_sql_optional_u32(progress.stream_episode),
                to_sql_optional_u32(progress.aniskip_episode),
                progress.position,
                progress.duration,
                to_sql_i64(progress.last_watched),
                progress.title,
                progress.poster,
                progress.backdrop,
                progress.last_stream_url,
                progress.last_stream_format,
                progress.last_stream_lookup_id,
                progress.last_stream_key,
                progress.source_name,
                progress.stream_family,
            ],
        )
        .map_err(|error| format!("Failed to save playback resume row: {}", error))?;

    Ok(())
}

fn prune_title_history_tx(
    transaction: &Transaction<'_>,
    media_type: &str,
    media_id: &str,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "
            SELECT history_key
            FROM watch_progress
            WHERE media_type = ?1 AND media_id = ?2
            ORDER BY last_watched DESC, history_key DESC
            LIMIT -1 OFFSET ?3
            ",
        )
        .map_err(|error| format!("Failed to prepare playback resume prune query: {}", error))?;

    let keys_to_delete = statement
        .query_map(
            params![media_type, media_id, MAX_RESUME_ROWS_PER_TITLE as i64],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| {
            format!(
                "Failed to query playback resume prune candidates: {}",
                error
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read playback resume prune candidates: {}", error))?;

    if keys_to_delete.is_empty() {
        return Ok(());
    }

    let mut delete_statement = transaction
        .prepare("DELETE FROM watch_progress WHERE history_key = ?1")
        .map_err(|error| format!("Failed to prepare playback resume prune delete: {}", error))?;

    for key in keys_to_delete {
        delete_statement
            .execute(params![key])
            .map_err(|error| format!("Failed to prune playback resume row: {}", error))?;
    }

    Ok(())
}

fn read_watch_progress_row(row: &Row<'_>) -> rusqlite::Result<(String, WatchProgress)> {
    let history_key = row.get::<_, String>(0)?;
    let progress = WatchProgress {
        id: row.get(1)?,
        type_: row.get(2)?,
        season: from_sql_optional_u32(row.get(3)?),
        episode: from_sql_optional_u32(row.get(4)?),
        absolute_season: from_sql_optional_u32(row.get(5)?),
        absolute_episode: from_sql_optional_u32(row.get(6)?),
        stream_season: from_sql_optional_u32(row.get(7)?),
        stream_episode: from_sql_optional_u32(row.get(8)?),
        aniskip_episode: from_sql_optional_u32(row.get(9)?),
        position: row.get(10)?,
        duration: row.get(11)?,
        last_watched: from_sql_u64(row.get::<_, i64>(12)?),
        title: row.get(13)?,
        poster: row.get(14)?,
        backdrop: row.get(15)?,
        last_stream_url: row.get(16)?,
        last_stream_format: row.get(17)?,
        last_stream_lookup_id: row.get(18)?,
        last_stream_key: row.get(19)?,
        source_name: row.get(20)?,
        stream_family: row.get(21)?,
        resume_start_time: None,
    };

    Ok((history_key, progress))
}

fn to_sql_optional_u32(value: Option<u32>) -> Option<i64> {
    value.map(i64::from)
}

fn from_sql_optional_u32(value: Option<i64>) -> Option<u32> {
    value.and_then(|value| u32::try_from(value).ok())
}

fn to_sql_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_sql_u64(value: i64) -> u64 {
    u64::try_from(value.max(0)).unwrap_or_default()
}
