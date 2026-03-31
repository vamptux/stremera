const YOUTUBE_EMBED_BASE_URL = 'https://www.youtube-nocookie.com/embed';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export interface YouTubeEmbedOptions {
  autoplay?: boolean;
  mute?: boolean;
  controls?: boolean;
  loop?: boolean;
  modestBranding?: boolean;
  playsInline?: boolean;
  rel?: boolean;
}

function isValidYouTubeVideoId(candidate: string | null | undefined): candidate is string {
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{11}$/.test(candidate);
}

export function extractYouTubeVideoId(rawUrl?: string | null): string | null {
  const candidate = rawUrl?.trim();
  if (!candidate) return null;

  if (isValidYouTubeVideoId(candidate)) {
    return candidate;
  }

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();

    if (!YOUTUBE_HOSTS.has(host)) {
      return null;
    }

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const pathId = url.pathname.split('/').filter(Boolean)[0];
      return isValidYouTubeVideoId(pathId) ? pathId : null;
    }

    const pathSegments = url.pathname.split('/').filter(Boolean);
    const trailingPathId = pathSegments[pathSegments.length - 1];
    const directId =
      url.searchParams.get('v') ||
      url.searchParams.get('vi') ||
      url.pathname.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\b|\/|$)/)?.[1] ||
      trailingPathId;

    return isValidYouTubeVideoId(directId) ? directId : null;
  } catch {
    const fallbackMatch = String(candidate).match(
      /(?:v=|vi=|embed\/|shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
    );
    return isValidYouTubeVideoId(fallbackMatch?.[1]) ? fallbackMatch[1] : null;
  }
}

export function buildYouTubeEmbedUrl(
  videoId: string,
  {
    autoplay = false,
    mute = false,
    controls = true,
    loop = false,
    modestBranding = true,
    playsInline = true,
    rel = false,
  }: YouTubeEmbedOptions = {},
): string {
  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    controls: controls ? '1' : '0',
    mute: mute ? '1' : '0',
    playsinline: playsInline ? '1' : '0',
    rel: rel ? '1' : '0',
  });

  if (modestBranding) {
    params.set('modestbranding', '1');
  }

  if (loop) {
    params.set('loop', '1');
    params.set('playlist', videoId);
  }

  return `${YOUTUBE_EMBED_BASE_URL}/${videoId}?${params.toString()}`;
}

export function resolveTrailerEmbedUrl(
  rawUrl?: string | null,
  options?: YouTubeEmbedOptions,
): string | null {
  const videoId = extractYouTubeVideoId(rawUrl);
  return videoId ? buildYouTubeEmbedUrl(videoId, options) : null;
}