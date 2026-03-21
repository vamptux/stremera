mod commands;
pub mod downloader;
pub mod providers;

use downloader::DownloadManager;
use providers::cinemeta::Cinemeta;
use providers::kitsu::Kitsu;
use providers::netflix::Netflix;
use providers::realdebrid::RealDebrid;
use providers::skip_times::SkipTimesProvider;
use providers::torrentio::Torrentio;
use tauri::Manager;
use tauri_plugin_store::Builder as StoreBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(StoreBuilder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(DownloadManager::new(handle.clone()));

            if let Err(err) = commands::migrate_legacy_app_data_stores(&handle) {
                eprintln!("Legacy data-store migration skipped: {}", err);
            }

            Ok(())
        })
        .manage(Cinemeta::new())
        .manage(RealDebrid::new())
        .manage(Torrentio::new())
        .manage(Netflix::new())
        .manage(Kitsu::new())
        .manage(SkipTimesProvider::new())
        .invoke_handler(tauri::generate_handler![
            commands::resolve_stream,
            commands::resolve_best_stream,
            commands::get_streams,
            commands::get_streams_for_addon,
            commands::get_app_config,
            commands::get_trending_movies,
            commands::get_trending_series,
            commands::get_trending_anime,
            commands::get_cinemeta_catalog,
            commands::get_cinemeta_discover,
            commands::search_media,
            commands::get_media_details,
            commands::get_media_episodes,
            commands::get_rd_user,
            commands::rd_verify_token,
            commands::rd_logout,
            commands::save_watch_progress,
            commands::get_watch_history,
            commands::get_watch_history_full,
            commands::get_watch_history_for_id,
            commands::get_watch_progress,
            commands::remove_from_watch_history,
            commands::remove_all_from_watch_history,
            commands::save_torrentio_config,
            commands::get_torrentio_config,
            commands::get_addon_configs,
            commands::save_addon_configs,
            commands::fetch_addon_manifest,
            commands::save_playback_language_preferences,
            commands::get_playback_language_preferences,
            commands::save_debrid_config,
            commands::get_debrid_config,
            commands::add_to_library,
            commands::remove_from_library,
            commands::get_library,
            commands::check_library,
            commands::get_netflix_catalog,
            commands::get_kitsu_catalog,
            commands::search_kitsu,
            commands::create_list,
            commands::delete_list,
            commands::rename_list,
            commands::add_to_list,
            commands::remove_from_list,
            commands::get_lists,
            commands::reorder_list_items,
            commands::reorder_lists,
            commands::check_item_in_lists,
            commands::set_watch_status,
            commands::get_watch_status,
            commands::get_all_watch_statuses,
            commands::start_download,
            commands::pause_download,
            commands::resume_download,
            commands::check_download_file_exists,
            commands::cancel_download,
            commands::remove_download,
            commands::get_downloads,
            commands::set_download_bandwidth,
            commands::get_default_download_path,
            commands::open_folder,
            commands::get_skip_times,
            commands::get_data_stats,
            commands::clear_watch_history,
            commands::clear_library,
            commands::clear_all_lists,
            commands::clear_all_watch_statuses,
            commands::export_app_data,
            commands::import_app_data,
            commands::export_app_data_to_file,
            commands::import_app_data_from_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
