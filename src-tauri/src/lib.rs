mod commands;
pub mod downloader;
mod operational_log;
pub mod providers;

use commands::playback_state::PlaybackStateService;
use commands::PendingAppUpdate;
use downloader::DownloadManager;
use providers::addons::AddonTransport;
use providers::cinemeta::Cinemeta;
use providers::kitsu::Kitsu;
use providers::netflix::Netflix;
use providers::realdebrid::RealDebrid;
use providers::skip_times::SkipTimesProvider;
use tauri::Manager;
use tauri_plugin_store::Builder as StoreBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(icon) = webview.app_handle().default_window_icon().cloned() {
                    let _ = webview.window().set_icon(icon);
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(StoreBuilder::default().build())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon);
                }
            }

            let handle = app.handle().clone();
            app.manage(DownloadManager::new(handle.clone()));
            app.manage(PlaybackStateService::new());
            app.manage(PendingAppUpdate::default());

            if let Err(err) = commands::run_startup_migrations(&handle) {
                eprintln!("Startup migration skipped: {}", err);
            }

            Ok(())
        })
        .manage(Cinemeta::new())
        .manage(RealDebrid::new())
        .manage(AddonTransport::new())
        .manage(Netflix::new())
        .manage(Kitsu::new())
        .manage(SkipTimesProvider::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_update_commands::get_current_app_version,
            commands::app_update_commands::check_for_app_update,
            commands::app_update_commands::install_app_update,
            commands::stream_commands::resolve_stream,
            commands::stream_commands::resolve_best_stream,
            commands::stream_commands::recover_playback_stream,
            commands::stream_commands::get_streams,
            commands::stream_commands::get_stream_selector_data,
            commands::get_trending_movies,
            commands::get_trending_series,
            commands::get_trending_anime,
            commands::search_commands::query_search_catalog,
            commands::search_history_commands::get_search_history,
            commands::search_history_commands::import_search_history_entries,
            commands::search_history_commands::push_search_history_entry,
            commands::search_history_commands::remove_search_history_entry,
            commands::search_history_commands::clear_search_history,
            commands::media_commands::get_media_details,
            commands::media_commands::get_media_episodes,
            commands::media_commands::get_kitsu_anime_metadata,
            commands::next_playback_commands::prepare_next_playback_plan,
            commands::history_playback_commands::build_history_playback_plan,
            commands::get_rd_user,
            commands::rd_verify_token,
            commands::rd_logout,
            commands::playback_state_commands::report_playback_stream_outcome,
            commands::watch_history_commands::save_watch_progress,
            commands::watch_history_commands::get_watch_history,
            commands::watch_history_commands::get_continue_watching,
            commands::watch_history_commands::get_watch_history_full,
            commands::watch_history_commands::get_watch_history_for_id,
            commands::watch_history_commands::get_watch_progress,
            commands::watch_history_commands::remove_from_watch_history,
            commands::watch_history_commands::remove_all_from_watch_history,
            commands::config_commands::get_addon_configs,
            commands::config_commands::save_addon_configs,
            commands::config_commands::fetch_addon_manifest,
            commands::playback_preferences_commands::save_playback_language_preferences,
            commands::playback_preferences_commands::get_playback_language_preferences,
            commands::playback_preferences_commands::get_effective_playback_language_preferences,
            commands::playback_preferences_commands::infer_track_language_preference,
            commands::playback_preferences_commands::resolve_preferred_track_selection,
            commands::playback_preferences_commands::save_playback_language_preference_outcome,
            commands::config_commands::save_debrid_config,
            commands::config_commands::get_debrid_config,
            commands::config_commands::get_app_ui_preferences,
            commands::config_commands::save_app_ui_preferences,
            commands::config_commands::import_legacy_app_ui_preferences,
            commands::config_commands::get_last_notified_app_update_version,
            commands::config_commands::save_last_notified_app_update_version,
            commands::config_commands::import_legacy_last_notified_app_update_version,
            commands::config_commands::get_profile_preferences,
            commands::config_commands::save_profile_preferences,
            commands::config_commands::import_legacy_profile_preferences,
            commands::config_commands::get_stream_selector_preferences,
            commands::config_commands::save_stream_selector_preferences,
            commands::config_commands::import_legacy_stream_selector_preferences,
            commands::library_commands::add_to_library,
            commands::library_commands::remove_from_library,
            commands::library_commands::get_library,
            commands::library_commands::check_library,
            commands::list_commands::create_list,
            commands::list_commands::delete_list,
            commands::list_commands::rename_list,
            commands::list_commands::add_to_list,
            commands::list_commands::remove_from_list,
            commands::list_commands::get_lists,
            commands::list_commands::reorder_list_items,
            commands::list_commands::reorder_lists,
            commands::list_commands::check_item_in_lists,
            commands::watch_status_commands::set_watch_status,
            commands::watch_status_commands::get_watch_status,
            commands::watch_status_commands::get_all_watch_statuses,
            commands::download_commands::start_download,
            commands::download_commands::pause_download,
            commands::download_commands::pause_active_downloads,
            commands::download_commands::resume_download,
            commands::download_commands::check_download_file_exists,
            commands::download_commands::cancel_download,
            commands::download_commands::remove_download,
            commands::download_commands::clear_completed_downloads,
            commands::download_commands::get_downloads,
            commands::download_commands::set_download_bandwidth,
            commands::download_commands::get_default_download_path,
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
