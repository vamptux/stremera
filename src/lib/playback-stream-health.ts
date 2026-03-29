export type SavedStreamReuseKind =
  | 'unknown'
  | 'local-file'
  | 'localhost'
  | 'remote-debrid'
  | 'remote-signed'
  | 'remote-manifest'
  | 'remote-direct';

export interface PlaybackStreamReusePolicy {
  kind: SavedStreamReuseKind;
  isRemote: boolean;
  shouldBypass: boolean;
  canReuseDirectly: boolean;
  lastFailureReason?: string;
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastVerifiedAt?: number;
  lastFailureAt?: number;
}

export type PlaybackStreamOutcome =
  | 'verified'
  | 'expired-saved-stream'
  | 'startup-timeout'
  | 'load-failed'
  | 'disconnected';

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