export type PlaybackStreamOutcome = 'verified' | 'startup-timeout' | 'load-failed' | 'disconnected';

export interface PlaybackStreamOutcomeReport {
  id: string;
  type_: string;
  season?: number;
  episode?: number;
  source_name?: string;
  stream_family?: string;
  stream_url?: string;
  stream_format?: string;
  stream_lookup_id?: string;
  stream_key?: string;
  outcome: PlaybackStreamOutcome;
}
