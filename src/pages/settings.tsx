import { useCallback, useRef, useState, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  getErrorMessage,
  type PlaybackLanguagePreferences,
  type AddonConfig,
} from '@/lib/api';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Loader2,
  Keyboard,
  Zap,
  Globe,
  Trash2,
  Captions,
  Music2,
  Check,
  ChevronDown,
  Database,
  AlertTriangle,
  Download,
  Upload,
  Eye,
  EyeOff,
  Settings2,
  BarChart3,
  Plus,
  GripVertical,
  Power,
  ExternalLink,
  History as HistoryIcon,
  Library,
  LayoutList,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSpoilerProtection } from '@/hooks/use-spoiler-protection';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { normalizeLanguageToken } from '@/lib/player-track-utils';
import { useAppUpdater } from '@/hooks/use-app-updater';

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'Japanese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
];

export function Settings({ embedded }: { embedded?: boolean }) {
  return (
    <div className={cn('container mx-auto py-8 max-w-5xl', embedded && 'py-0 px-0 max-w-none')}>
      {!embedded && (
        <div className='mb-6'>
          <h1 className='text-xl font-semibold text-white tracking-tight'>Settings</h1>
          <p className='text-xs text-zinc-600 mt-1'>Manage your preferences and configuration.</p>
        </div>
      )}

      <Tabs defaultValue='streaming' className='flex flex-row gap-0'>
        <TabsList className='flex-col w-44 shrink-0 bg-transparent border-r border-white/[0.06] pr-2 mr-6 h-fit items-stretch gap-0.5 self-start'>
          <TabsTrigger
            value='streaming'
            className='justify-start px-3 py-2.5 rounded text-[13px] font-medium data-[state=active]:bg-white/[0.08] data-[state=active]:text-white text-zinc-500 transition-colors duration-150 data-[state=active]:shadow-none hover:text-zinc-300 hover:bg-white/[0.04] flex items-center gap-2.5'
          >
            <Zap className='w-[15px] h-[15px] shrink-0' />
            Streaming
          </TabsTrigger>
          <TabsTrigger
            value='playback'
            className='justify-start px-3 py-2.5 rounded text-[13px] font-medium data-[state=active]:bg-white/[0.08] data-[state=active]:text-white text-zinc-500 transition-colors duration-150 data-[state=active]:shadow-none hover:text-zinc-300 hover:bg-white/[0.04] flex items-center gap-2.5'
          >
            <Settings2 className='w-[15px] h-[15px] shrink-0' />
            Playback
          </TabsTrigger>
          <TabsTrigger
            value='shortcuts'
            className='justify-start px-3 py-2.5 rounded text-[13px] font-medium data-[state=active]:bg-white/[0.08] data-[state=active]:text-white text-zinc-500 transition-colors duration-150 data-[state=active]:shadow-none hover:text-zinc-300 hover:bg-white/[0.04] flex items-center gap-2.5'
          >
            <Keyboard className='w-[15px] h-[15px] shrink-0' />
            Shortcuts
          </TabsTrigger>
          <TabsTrigger
            value='data'
            className='justify-start px-3 py-2.5 rounded text-[13px] font-medium data-[state=active]:bg-white/[0.08] data-[state=active]:text-white text-zinc-500 transition-colors duration-150 data-[state=active]:shadow-none hover:text-zinc-300 hover:bg-white/[0.04] flex items-center gap-2.5'
          >
            <BarChart3 className='w-[15px] h-[15px] shrink-0' />
            Data
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 min-w-0">
          <TabsContent value='streaming' className='mt-0 space-y-4 animate-in fade-in duration-200'>
            <AddonManager />
          </TabsContent>

          <TabsContent value='playback' className='mt-0 space-y-4 animate-in fade-in duration-200'>
            <PlaybackLanguageConfig />
            <SpoilerProtectionToggle />
          </TabsContent>

          <TabsContent value='shortcuts' className='mt-0 animate-in fade-in duration-200'>
            <KeyboardShortcuts />
          </TabsContent>

          <TabsContent value='data' className='mt-0 space-y-4 animate-in fade-in duration-200'>
            <ApplicationUpdatesCard />
            <DataManager />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function ApplicationUpdatesCard() {
  const {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isChecking,
    isInstalling,
    isSupported,
    isUpdateAvailable,
    pendingUpdate,
    updateState,
  } = useAppUpdater();

  const currentLabel = currentVersion ?? 'Unknown';
  const latestLabel = pendingUpdate?.version ?? (updateState.status === 'up-to-date' ? 'Up to date' : 'No update detected');
  const lastCheckedLabel = updateState.lastCheckedAt
    ? `${formatDistanceToNow(updateState.lastCheckedAt, { addSuffix: true })}`
    : 'Not checked yet';
  const statusNote = !isSupported
    ? 'Updater controls are only active inside the packaged desktop app.'
    : isInstalling
      ? updateState.installStatus ?? 'Applying the update and preparing to relaunch.'
      : isUpdateAvailable
        ? 'A signed update is ready. Installing will replace the current app in place and keep your existing app data.'
        : updateState.status === 'up-to-date'
          ? 'The installed build matches the latest signed GitHub release.'
          : 'Downloads use temporary installer artifacts and NSIS replaces the existing app in place.';

  const handleCheck = () => {
    void checkForUpdates()
      .then((update) => {
        if (!update) {
          toast.success('Stremera is up to date');
          return;
        }

        toast.info(`Update ${update.version} is available`, {
          description: 'Install the latest signed desktop release from GitHub Releases.',
        });
      })
      .catch((error) => {
        toast.error(`Update check failed: ${getErrorMessage(error)}`);
      });
  };

  const handleInstall = () => {
    if (!pendingUpdate) return;

    toast.loading('Downloading update…', { id: 'app-update-install' });
    void installUpdate(pendingUpdate, (status) => {
      toast.loading(status, { id: 'app-update-install' });
    }).catch((error) => {
      toast.error(`Update install failed: ${getErrorMessage(error)}`, {
        id: 'app-update-install',
      });
    });
  };

  return (
    <div
      className={cn(
        'rounded-md border overflow-hidden transition-colors',
        isUpdateAvailable
          ? 'border-emerald-400/20 bg-[linear-gradient(180deg,rgba(16,185,129,0.08),rgba(255,255,255,0.015))]'
          : 'border-white/[0.06] bg-white/[0.015]',
      )}
    >
      <div className='px-5 py-4 border-b border-white/5 flex items-start gap-3'>
        <RefreshCw
          className={cn(
            'w-4 h-4 flex-shrink-0 mt-0.5',
            isUpdateAvailable ? 'text-emerald-300' : 'text-zinc-500',
          )}
        />
        <div>
          <h2 className='text-sm font-semibold text-white'>Application Updates</h2>
          <p className='text-[11px] text-zinc-500 mt-0.5 leading-relaxed'>
            Releases are distributed as signed NSIS installers on GitHub Releases. In-app updates
            replace the current install instead of stacking full app copies.
          </p>
        </div>
      </div>

      <div className='px-5 py-4 space-y-4'>
        <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
          <div className='rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-3'>
            <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-600'>
              Current Version
            </p>
            <p className='mt-1 text-sm font-semibold text-white'>{currentLabel}</p>
          </div>
          <div className='rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-3'>
            <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-600'>
              Latest Status
            </p>
            <p className='mt-1 text-sm font-semibold text-white'>{latestLabel}</p>
            <p className='mt-1 text-[11px] text-zinc-500'>Last checked {lastCheckedLabel}</p>
          </div>
        </div>

        {updateState.errorMessage && !isUpdateAvailable && (
          <div className='rounded-md border border-red-500/20 bg-red-500/5 px-4 py-3'>
            <p className='text-[10px] font-semibold uppercase tracking-widest text-red-300/80'>
              Updater Error
            </p>
            <p className='mt-1 text-[12px] leading-relaxed text-red-100/80'>
              {updateState.errorMessage}
            </p>
          </div>
        )}

        {pendingUpdate?.body && (
          <div className='rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-3'>
            <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-600'>
              Release Notes
            </p>
            <p className='mt-1 text-[12px] leading-relaxed text-zinc-400 whitespace-pre-wrap'>
              {pendingUpdate.body}
            </p>
          </div>
        )}

        <div className='flex items-center gap-3 flex-wrap'>
          <Button
            size='sm'
            variant='outline'
            onClick={handleCheck}
            disabled={!isSupported || isChecking || isInstalling}
            className='h-8 px-4 text-xs font-semibold gap-1.5 border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-white'
          >
            {isChecking ? (
              <Loader2 className='w-3 h-3 animate-spin' />
            ) : (
              <RefreshCw className='w-3 h-3' />
            )}
            Check for Updates
          </Button>

          <Button
            size='sm'
            onClick={handleInstall}
            disabled={!pendingUpdate || isInstalling || isChecking}
            className={cn(
              'h-8 px-4 text-xs font-semibold gap-1.5 text-black hover:bg-zinc-200',
              isUpdateAvailable ? 'bg-emerald-300 hover:bg-emerald-200' : 'bg-white',
            )}
          >
            {isInstalling ? (
              <Loader2 className='w-3 h-3 animate-spin' />
            ) : (
              <Download className='w-3 h-3' />
            )}
            Install and Restart
          </Button>

          <p className='text-[10px] text-zinc-700 flex-1 min-w-[220px]'>
            {statusNote}
          </p>
        </div>
      </div>
    </div>
  );
}

function normalizePreference(value: string): string {
  return normalizeLanguageToken(value);
}

function formatLanguageLabel(value: string, kind: 'audio' | 'subtitle'): string {
  const normalized = normalizePreference(value);
  if (!normalized) return 'Auto';
  if (kind === 'subtitle' && normalized === 'off') return 'Off';
  const option = LANGUAGE_OPTIONS.find((lang) => lang.value === normalized);
  if (option) return `${option.label} (${option.value})`;
  return normalized;
}

function PlaybackLanguageConfig() {
  const queryClient = useQueryClient();
  const [audioLang, setAudioLang] = useState<string | undefined>(undefined);
  const [subtitleLang, setSubtitleLang] = useState<string | undefined>(undefined);

  const { data: currentPrefs, isLoading } = useQuery({
    queryKey: ['playbackLanguagePreferences'],
    queryFn: api.getPlaybackLanguagePreferences,
  });

  const saveMutation = useMutation({
    mutationFn: (prefs: PlaybackLanguagePreferences) =>
      api.savePlaybackLanguagePreferences(
        prefs.preferredAudioLanguage,
        prefs.preferredSubtitleLanguage,
      ),
    onSuccess: (_result, prefs) => {
      setAudioLang(undefined);
      setSubtitleLang(undefined);
      queryClient.setQueryData(['playbackLanguagePreferences'], {
        preferredAudioLanguage: prefs.preferredAudioLanguage,
        preferredSubtitleLanguage: prefs.preferredSubtitleLanguage,
      });
      queryClient.invalidateQueries({ queryKey: ['playbackLanguagePreferences'] });
      queryClient.invalidateQueries({ queryKey: ['effectivePlaybackLanguagePreferences'] });
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      toast.success('Playback language preferences saved');
    },
    onError: (err: unknown) => toast.error(getErrorMessage(err)),
  });

  const audioValue = audioLang ?? currentPrefs?.preferredAudioLanguage ?? '';
  const subtitleValue = subtitleLang ?? currentPrefs?.preferredSubtitleLanguage ?? '';

  const normalizedAudio = normalizePreference(audioValue);
  const normalizedSubtitle = normalizePreference(subtitleValue);
  const currentAudio = normalizePreference(currentPrefs?.preferredAudioLanguage ?? '');
  const currentSubtitle = normalizePreference(currentPrefs?.preferredSubtitleLanguage ?? '');
  const isDirty = normalizedAudio !== currentAudio || normalizedSubtitle !== currentSubtitle;

  const handleSave = () => {
    saveMutation.mutate({
      preferredAudioLanguage: normalizedAudio || undefined,
      preferredSubtitleLanguage: normalizedSubtitle || undefined,
    });
  };

  return (
    <div className='rounded-md border border-white/[0.06] bg-zinc-900/40 overflow-hidden'>
      <div className='px-6 py-5 border-b border-white/[0.08] flex items-start gap-3 bg-white/[0.02]'>
        <Captions className='w-5 h-5 text-zinc-400 flex-shrink-0 mt-0.5' />
        <div>
          <h2 className='text-[15px] font-semibold text-white'>Preferred Audio & Subtitles</h2>
          <p className='text-xs text-zinc-500 mt-1 leading-relaxed max-w-xl'>
            Set language codes (like <span className='text-zinc-300 font-medium'>en</span> or{' '}
            <span className='text-zinc-300 font-medium'>ja</span>). The player auto-selects matching
            tracks when available. Set subtitle language to{' '}
            <span className='text-zinc-300 font-medium'>off</span> to disable subtitles by default.
          </p>
        </div>
      </div>

      <div className='px-6 py-6 space-y-6'>
        <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
          <div className='space-y-2'>
            <label className='text-[11px] font-semibold text-zinc-500 uppercase tracking-widest inline-flex items-center gap-1.5'>
              <Music2 className='w-3.5 h-3.5' /> Audio Language
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  className='w-full justify-between bg-zinc-800/60 border-white/[0.08] hover:bg-zinc-800 hover:border-white/20 text-[13px] font-normal h-11 rounded-md transition-all'
                >
                  <span className='truncate'>{formatLanguageLabel(audioValue, 'audio')}</span>
                  <ChevronDown className='h-4 w-4 opacity-50 shrink-0 ml-2' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                className='w-[var(--radix-dropdown-menu-trigger-width)] bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-md p-1.5'
              >
                <DropdownMenuItem
                  onClick={() => setAudioLang('')}
                  className='gap-2.5 py-2 text-[13px] rounded-md cursor-pointer'
                >
                  {!normalizePreference(audioValue) ? (
                    <Check className='h-4 w-4 opacity-70' />
                  ) : (
                    <div className='w-4' />
                  )}
                  <span>Auto</span>
                </DropdownMenuItem>
                {LANGUAGE_OPTIONS.map((option) => {
                  const selected = normalizePreference(audioValue) === option.value;
                  return (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => setAudioLang(option.value)}
                      className='gap-2.5 py-2 text-[13px] rounded-md cursor-pointer'
                    >
                      {selected ? (
                        <Check className='h-4 w-4 opacity-70' />
                      ) : (
                        <div className='w-4' />
                      )}
                      <span>
                        {option.label} ({option.value})
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className='space-y-2'>
            <label className='text-[11px] font-semibold text-zinc-500 uppercase tracking-widest inline-flex items-center gap-1.5'>
              <Captions className='w-3.5 h-3.5' /> Subtitle Language
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  className='w-full justify-between bg-zinc-800/60 border-white/[0.08] hover:bg-zinc-800 hover:border-white/20 text-[13px] font-normal h-11 rounded-md transition-all'
                >
                  <span className='truncate'>{formatLanguageLabel(subtitleValue, 'subtitle')}</span>
                  <ChevronDown className='h-4 w-4 opacity-50 shrink-0 ml-2' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                className='w-[var(--radix-dropdown-menu-trigger-width)] bg-zinc-950/95 border-white/10 backdrop-blur-md rounded-md p-1.5'
              >
                <DropdownMenuItem
                  onClick={() => setSubtitleLang('')}
                  className='gap-2.5 py-2 text-[13px] rounded-md cursor-pointer'
                >
                  {!normalizePreference(subtitleValue) ? (
                    <Check className='h-4 w-4 opacity-70' />
                  ) : (
                    <div className='w-4' />
                  )}
                  <span>Auto</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSubtitleLang('off')}
                  className='gap-2.5 py-2 text-[13px] rounded-md cursor-pointer'
                >
                  {normalizePreference(subtitleValue) === 'off' ? (
                    <Check className='h-4 w-4 opacity-70' />
                  ) : (
                    <div className='w-4' />
                  )}
                  <span>Off</span>
                </DropdownMenuItem>
                {LANGUAGE_OPTIONS.map((option) => {
                  const selected = normalizePreference(subtitleValue) === option.value;
                  return (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => setSubtitleLang(option.value)}
                      className='gap-2.5 py-2 text-[13px] rounded-md cursor-pointer'
                    >
                      {selected ? (
                        <Check className='h-4 w-4 opacity-70' />
                      ) : (
                        <div className='w-4' />
                      )}
                      <span>
                        {option.label} ({option.value})
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className='flex items-center justify-between pt-5 border-t border-white/[0.08]'>
          <div className='text-[13px] text-zinc-500'>
            {isDirty && (
              <span className='text-amber-400 font-medium flex items-center gap-1.5'>
                <AlertTriangle className='h-4 w-4' /> Unsaved changes
              </span>
            )}
          </div>
          <div className='flex gap-2.5'>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                setAudioLang('');
                setSubtitleLang('');
              }}
              disabled={isLoading || saveMutation.isPending}
              className='h-10 px-5 text-[13px] font-semibold rounded-md bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.08]'
            >
              Reset
            </Button>
            <Button
              size='sm'
              onClick={handleSave}
              disabled={isLoading || !isDirty || saveMutation.isPending}
              className='h-10 px-6 bg-white text-black hover:bg-zinc-200 transition-colors rounded-md text-[13px] font-semibold gap-2 shadow-sm whitespace-nowrap'
            >
              {saveMutation.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Spoiler Protection Toggle ───────────────────────────────────────────────

function SpoilerProtectionToggle() {
  const { spoilerProtection, setSpoilerProtection } = useSpoilerProtection();

  return (
    <div className='rounded-md border border-white/[0.06] bg-white/[0.015] overflow-hidden'>
      <div className='px-5 py-4 flex items-center justify-between gap-4'>
        <div className='flex items-start gap-3 min-w-0'>
          <div className='w-8 h-8 rounded-md bg-white/5 flex items-center justify-center text-zinc-500 flex-shrink-0 mt-0.5'>
            {spoilerProtection ? <EyeOff className='w-4 h-4' /> : <Eye className='w-4 h-4' />}
          </div>
          <div className='min-w-0'>
            <p className='text-sm font-semibold text-white'>Spoiler Protection</p>
            <p className='text-[11px] text-zinc-500 mt-0.5 leading-relaxed'>
              Blur episode thumbnails and hide descriptions for episodes you haven&apos;t watched
              yet. Only applies once you&apos;ve started a season.
            </p>
          </div>
        </div>
        <button
          type='button'
          role='switch'
          aria-checked={spoilerProtection}
          onClick={() => setSpoilerProtection(!spoilerProtection)}
          className={cn(
            'relative inline-flex items-center flex-shrink-0 w-12 h-7 rounded-full border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 shadow-inner',
            spoilerProtection
              ? 'bg-white border-white/70'
              : 'bg-zinc-800/90 border-white/15 hover:border-white/25',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 w-6 h-6 rounded-full shadow-md transition-transform duration-200 flex items-center justify-center',
              spoilerProtection
                ? 'translate-x-5 bg-black text-white'
                : 'translate-x-0 bg-white/90 text-zinc-800',
            )}
          >
            {spoilerProtection ? <EyeOff className='w-3 h-3' /> : <Eye className='w-3 h-3' />}
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── Addon Manager (multi-source streaming) ──────────────────────────────────

function generateId(): string {
  return `addon-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeAddonUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = trimmed.startsWith('stremio://')
    ? `https://${trimmed.slice('stremio://'.length)}`
    : trimmed.includes('://')
      ? trimmed
      : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Keep query params because some addon configs are encoded in `?...`.
  parsed.hash = '';

  const normalizedPath = parsed.pathname.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  parsed.pathname = normalizedPath || '/';

  return parsed.toString().replace(/\/$/, '');
}

function isConfigureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/configure\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

interface SortableAddonRowProps {
  addon: AddonConfig;
  idx: number;
  total: number;
  isWorking: boolean;
  onMove: (id: string, direction: -1 | 1) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

function SortableAddonRow({
  addon,
  idx,
  total,
  isWorking,
  onMove,
  onToggle,
  onRemove,
}: SortableAddonRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: addon.id,
    disabled: isWorking,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'px-6 py-4 flex items-center gap-3 transition-colors',
        !addon.enabled && 'opacity-50',
        isDragging && 'bg-white/[0.04] ring-1 ring-white/20',
      )}
    >
      {/* Drag handle */}
      <button
        type='button'
        {...attributes}
        {...listeners}
        disabled={isWorking}
        className='w-7 h-7 rounded-md flex items-center justify-center text-zinc-700 hover:text-zinc-400 transition-colors cursor-grab active:cursor-grabbing disabled:opacity-30 disabled:cursor-not-allowed touch-none'
        aria-label='Drag source to reorder'
        title='Drag to reorder source priority'
      >
        <GripVertical className='w-4 h-4 flex-shrink-0' />
      </button>

      {/* Priority badge */}
      <span className='text-[10px] font-bold text-zinc-600 w-4 text-center flex-shrink-0'>
        {idx + 1}
      </span>

      {/* Info */}
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-2'>
          <span className='text-sm font-semibold text-white truncate'>{addon.name}</span>
          {addon.enabled ? (
            <span className='text-[9px] font-bold uppercase tracking-wide text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full'>
              Active
            </span>
          ) : (
            <span className='text-[9px] font-bold uppercase tracking-wide text-zinc-600 bg-zinc-800/60 border border-white/5 px-1.5 py-0.5 rounded-full'>
              Disabled
            </span>
          )}
        </div>
        <p className='text-[11px] text-zinc-600 truncate mt-0.5 font-mono'>
          {addon.url.replace(/\/manifest\.json$/i, '')}
        </p>
      </div>

      {/* Actions */}
      <div className='flex items-center gap-1.5 flex-shrink-0'>
        <button
          type='button'
          title='Move source up'
          onClick={() => onMove(addon.id, -1)}
          disabled={isWorking || idx === 0}
          className='w-8 h-8 rounded-md flex items-center justify-center text-zinc-600 hover:bg-white/5 hover:text-zinc-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed'
        >
          <ArrowUp className='w-3.5 h-3.5' />
        </button>
        <button
          type='button'
          title='Move source down'
          onClick={() => onMove(addon.id, 1)}
          disabled={isWorking || idx === total - 1}
          className='w-8 h-8 rounded-md flex items-center justify-center text-zinc-600 hover:bg-white/5 hover:text-zinc-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed'
        >
          <ArrowDown className='w-3.5 h-3.5' />
        </button>
        <button
          type='button'
          title={addon.enabled ? 'Disable addon' : 'Enable addon'}
          onClick={() => onToggle(addon.id)}
          disabled={isWorking}
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center transition-colors disabled:opacity-40',
            addon.enabled
              ? 'text-emerald-400 hover:bg-emerald-500/10'
              : 'text-zinc-600 hover:bg-white/5 hover:text-zinc-400',
          )}
        >
          <Power className='w-3.5 h-3.5' />
        </button>
        <button
          type='button'
          title='Remove addon'
          onClick={() => onRemove(addon.id)}
          disabled={isWorking}
          className='w-8 h-8 rounded-md flex items-center justify-center text-zinc-600 hover:bg-red-500/10 hover:text-red-400 transition-colors disabled:opacity-40'
        >
          <Trash2 className='w-3.5 h-3.5' />
        </button>
      </div>
    </div>
  );
}

function AddonManager() {
  const queryClient = useQueryClient();
  const [newUrl, setNewUrl] = useState('');
  const [fetchingManifest, setFetchingManifest] = useState(false);
  const newUrlInputRef = useRef<HTMLInputElement | null>(null);

  const { data: addons = [], isLoading } = useQuery({
    queryKey: ['addonConfigs'],
    queryFn: api.getAddonConfigs,
    staleTime: 1000 * 60 * 5,
  });

  const saveMutation = useMutation({
    mutationFn: api.saveAddonConfigs,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['addonConfigs'] });
      queryClient.invalidateQueries({ queryKey: ['streamsByAddon'] });
      queryClient.invalidateQueries({ queryKey: ['streams'] });
    },
    onError: (err: unknown) => toast.error(getErrorMessage(err)),
  });

  const handleToggle = (id: string) => {
    const updated = addons.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a));
    saveMutation.mutate(updated);
  };

  const handleMove = (id: string, direction: -1 | 1) => {
    const currentIndex = addons.findIndex((a) => a.id === id);
    if (currentIndex < 0) return;

    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= addons.length) return;

    const updated = [...addons];
    const [moved] = updated.splice(currentIndex, 1);
    updated.splice(targetIndex, 0, moved);
    saveMutation.mutate(updated);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const normalizedNewUrl = normalizeAddonUrl(newUrl);
  const isConfigureCandidate = normalizedNewUrl ? isConfigureUrl(normalizedNewUrl) : false;
  const duplicateAddon = normalizedNewUrl
    ? addons.find((addon) => normalizeAddonUrl(addon.url) === normalizedNewUrl)
    : undefined;
  const isWorking = isLoading || saveMutation.isPending || fetchingManifest;
  const canSubmitNewAddon =
    !!newUrl.trim() && !!normalizedNewUrl && !isConfigureCandidate && !duplicateAddon && !isWorking;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = addons.findIndex((addon) => addon.id === String(active.id));
      const newIndex = addons.findIndex((addon) => addon.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

      const reordered = arrayMove(addons, oldIndex, newIndex);
      saveMutation.mutate(reordered);
    },
    [addons, saveMutation],
  );

  const handleRemove = (id: string) => {
    const updated = addons.filter((a) => a.id !== id);
    saveMutation.mutate(updated, {
      onSuccess: () => {
        toast.success('Addon removed');
      },
    });
  };

  const handleAddUrl = async () => {
    const inputUrl = newUrl.trim();
    if (!inputUrl) return;

    const normalizedUrl = normalizeAddonUrl(inputUrl);
    if (!normalizedUrl) {
      toast.error('Invalid addon URL. Please use a valid http(s) URL.');
      return;
    }

    if (isConfigureUrl(normalizedUrl)) {
      toast.error(
        'This looks like a configure page URL. Open it and copy the generated manifest URL instead.',
      );
      return;
    }

    setFetchingManifest(true);
    try {
      let name = 'Custom Addon';
      try {
        const manifest = await api.fetchAddonManifest(normalizedUrl);
        if (manifest.name) name = manifest.name;
      } catch {
        // Manifest fetch failed — still allow adding with a fallback name
        toast.info('Could not fetch addon name — using URL as label.', { duration: 3000 });
      }

      // Avoid duplicate URLs
      if (duplicateAddon) {
        toast.error('This addon URL is already configured.');
        return;
      }

      const newAddon: AddonConfig = {
        id: generateId(),
        url: normalizedUrl,
        name,
        enabled: true,
      };

      saveMutation.mutate([...addons, newAddon], {
        onSuccess: () => {
          setNewUrl('');
          newUrlInputRef.current?.focus();
          toast.success(`Added ${name}`);
        },
      });
    } finally {
      setFetchingManifest(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void handleAddUrl();
    }
  };

  const activeCount = addons.filter((addon) => addon.enabled).length;

  return (
    <div className='rounded-md border border-white/[0.06] bg-zinc-900/40 overflow-hidden'>
      {/* Header */}
      <div className='px-6 py-5 border-b border-white/[0.08] flex items-start gap-3 bg-white/[0.02]'>
        <Zap className='w-5 h-5 text-zinc-400 flex-shrink-0 mt-0.5' />
        <div className='flex-1 min-w-0'>
          <h2 className='text-[15px] font-semibold text-white'>Stream Sources (Addons)</h2>
          <p className='text-xs text-zinc-500 mt-1 leading-relaxed max-w-xl'>
            Add any Stremio-compatible addon URL (Torrentio, Jackettio, Comet, StremThru, etc.).
            Streams from all enabled sources are merged — if one source is offline, others keep
            working.
          </p>
          {addons.length > 0 && (
            <p className='text-[11px] text-zinc-600 mt-2'>
              {activeCount}/{addons.length} active. Source order sets stream priority when
              duplicates appear.
            </p>
          )}
        </div>
      </div>

      <div className='divide-y divide-white/[0.04]'>
        {/* Configured addons list */}
        {isLoading ? (
          <div className='px-6 py-5 flex items-center gap-3 text-zinc-500 text-sm'>
            <Loader2 className='w-4 h-4 animate-spin' />
            Loading addons…
          </div>
        ) : addons.length === 0 ? (
          <div className='px-6 py-6 text-center text-zinc-600 text-sm'>
            No addons configured yet. Add one below.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={addons.map((addon) => addon.id)}
              strategy={verticalListSortingStrategy}
            >
              {addons.map((addon, idx) => (
                <SortableAddonRow
                  key={addon.id}
                  addon={addon}
                  idx={idx}
                  total={addons.length}
                  isWorking={isWorking}
                  onMove={handleMove}
                  onToggle={handleToggle}
                  onRemove={handleRemove}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}

        {/* Add new addon */}
        <div className='px-6 py-5 space-y-3'>
          <label className='text-[11px] font-semibold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5'>
            <Plus className='w-3.5 h-3.5' /> Add Addon
          </label>
          <div className='flex gap-2'>
            <Input
              ref={newUrlInputRef}
              placeholder='https://your-addon-host/.../manifest.json'
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isWorking}
              className='flex-1 h-10 bg-zinc-800/60 border-white/[0.08] text-sm font-mono focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 rounded-md'
            />
            <Button
              size='sm'
              onClick={handleAddUrl}
              disabled={!canSubmitNewAddon}
              className='h-10 px-5 bg-white text-black hover:bg-zinc-200 rounded-md text-[13px] font-semibold gap-1.5 shrink-0'
            >
              {fetchingManifest ? (
                <Loader2 className='w-3.5 h-3.5 animate-spin' />
              ) : (
                <Plus className='w-3.5 h-3.5' />
              )}
              Add
            </Button>
          </div>
          {newUrl.trim() && (
            <div className='space-y-1'>
              {!normalizedNewUrl ? (
                <p className='text-[11px] text-red-400'>Enter a valid http(s) addon URL.</p>
              ) : isConfigureCandidate ? (
                <p className='text-[11px] text-amber-400'>
                  This is a configure page. Open it, finish setup, then paste the generated manifest
                  URL.
                </p>
              ) : duplicateAddon ? (
                <p className='text-[11px] text-amber-400'>
                  This source is already configured as {duplicateAddon.name}.
                </p>
              ) : (
                <p className='text-[11px] text-emerald-400'>Ready to add: {normalizedNewUrl}</p>
              )}
            </div>
          )}
          <p className='text-[11px] text-zinc-600 leading-relaxed'>
            Paste the final addon URL (usually ending in{' '}
            <span className='text-zinc-500 font-mono'>/manifest.json</span>). If you only have a{' '}
            <span className='text-zinc-500 font-mono'>/configure</span> page, open it first and copy
            the generated install URL.
          </p>

          {/* Compatible addons hint */}
          <div className='rounded-md bg-zinc-950/50 border border-white/[0.05] px-4 py-3 space-y-1.5'>
            <p className='text-[10px] font-semibold text-zinc-600 uppercase tracking-widest flex items-center gap-1.5'>
              <Globe className='w-3 h-3' />
              Compatible Sources
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {[
                { name: 'Torrentio', url: 'https://torrentio.strem.fun' },
                { name: 'Jackettio', url: 'https://jackettio.elfhosted.com' },
                { name: 'Comet', url: 'https://comet.elfhosted.com' },
                { name: 'StremThru', url: 'https://stremthru.13377001.xyz' },
                { name: 'AutoStream', url: 'https://autostreamtest.onrender.com/configure' },
                { name: 'Orion', url: 'https://5a0d1888fa64-orion.baby-beamup.club/configure' },
              ].map((s) => (
                <a
                  key={s.name}
                  href={s.url}
                  target='_blank'
                  rel='noreferrer'
                  className='inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/60 border border-white/5 hover:border-white/10 px-2 py-1 rounded-md transition-colors'
                >
                  {s.name}
                  <ExternalLink className='w-2.5 h-2.5 opacity-60' />
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

interface ShortcutRow {
  label: string;
  keys: string[];
}

const APP_SHORTCUTS: ShortcutRow[] = [];

const PLAYER_SHORTCUTS: ShortcutRow[] = [
  { label: 'Play / Pause', keys: ['Space'] },
  { label: 'Play / Pause (alt)', keys: ['K'] },
  { label: 'Seek backward 10 s', keys: ['←'] },
  { label: 'Seek backward 10 s (alt)', keys: ['J'] },
  { label: 'Seek forward 10 s', keys: ['→'] },
  { label: 'Seek forward 10 s (alt)', keys: ['L'] },
  { label: 'Volume up', keys: ['↑'] },
  { label: 'Volume down', keys: ['↓'] },
  { label: 'Toggle fullscreen', keys: ['F'] },
  { label: 'Mute / Unmute', keys: ['M'] },
  { label: 'Next episode', keys: ['N'] },
  { label: 'Download stream', keys: ['D'] },
];

function ShortcutGroup({ rows }: { rows: ShortcutRow[] }) {
  return (
    <div className='divide-y divide-white/5'>
      {rows.map(({ label, keys }) => (
        <div key={label} className='flex items-center justify-between py-2.5 px-1'>
          <span className='text-sm text-zinc-300'>{label}</span>
          <div className='flex items-center gap-1'>
            {keys.map((key, i) => (
              <span key={i} className='flex items-center gap-1'>
                <kbd className='inline-flex items-center justify-center min-w-[1.75rem] h-6 px-1.5 rounded bg-zinc-800 border border-white/10 text-[11px] font-mono text-zinc-300 shadow-sm select-none'>
                  {key}
                </kbd>
                {i < keys.length - 1 && <span className='text-[10px] text-zinc-600'>+</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function KeyboardShortcuts() {
  return (
    <div className='rounded-md border border-white/[0.06] bg-white/[0.015] overflow-hidden'>
      <div className='px-5 py-4 border-b border-white/5 flex items-center gap-3'>
        <Keyboard className='w-4 h-4 text-zinc-500' />
        <div>
          <h2 className='text-sm font-semibold text-white'>Keyboard Shortcuts</h2>
          <p className='text-[11px] text-zinc-500 mt-0.5'>
            Global and player shortcuts available throughout the app.
          </p>
        </div>
      </div>
      <div className='px-5 py-4 space-y-6'>
        {APP_SHORTCUTS.length > 0 && (
          <div>
            <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-600 mb-2 px-1'>
              App
            </p>
            <ShortcutGroup rows={APP_SHORTCUTS} />
          </div>
        )}
        <div>
          <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-600 mb-2 px-1'>
            Video Player
          </p>
          <ShortcutGroup rows={PLAYER_SHORTCUTS} />
        </div>
      </div>
    </div>
  );
}

// ─── Data Manager ─────────────────────────────────────────────────────────────

interface DataCategory {
  key: 'history' | 'library' | 'lists' | 'statuses';
  label: string;
  description: string;
  icon: ReactNode;
  count: number;
  unit: string;
  clearFn: () => Promise<void>;
  clearQueryKeys: string[];
}

function DataManager() {
  const queryClient = useQueryClient();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ['dataStats'],
    queryFn: api.getDataStats,
    staleTime: 1000 * 30,
  });

  const clearMutation = useMutation({
    mutationFn: async (cat: DataCategory) => {
      await cat.clearFn();
      return cat;
    },
    onSuccess: (cat) => {
      setConfirmKey(null);
      for (const key of cat.clearQueryKeys) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      queryClient.invalidateQueries({ queryKey: ['dataStats'] });
      refetchStats();
      toast.success(`${cat.label} cleared`);
    },
    onError: (err: unknown, cat) => {
      setConfirmKey(null);
      toast.error(`Failed to clear ${cat.label}: ${getErrorMessage(err)}`);
    },
  });

  const categories: DataCategory[] = [
    {
      key: 'history',
      label: 'Watch History',
      description: 'All viewed episodes, movies and progress data.',
      icon: <HistoryIcon className='w-4 h-4' />,
      count: stats?.history_count ?? 0,
      unit: 'entries',
      clearFn: api.clearWatchHistory,
      clearQueryKeys: ['continue-watching', 'watch-history'],
    },
    {
      key: 'library',
      label: 'Library',
      description: 'Saved movies and shows in your personal library.',
      icon: <Library className='w-4 h-4' />,
      count: stats?.library_count ?? 0,
      unit: 'items',
      clearFn: api.clearLibrary,
      clearQueryKeys: ['library'],
    },
    {
      key: 'lists',
      label: 'Custom Lists',
      description: 'All custom lists and their contents.',
      icon: <LayoutList className='w-4 h-4' />,
      count: stats?.lists_count ?? 0,
      unit: 'lists',
      clearFn: api.clearAllLists,
      clearQueryKeys: ['lists'],
    },
    {
      key: 'statuses',
      label: 'Watch Statuses',
      description: 'Watching / Watched / Plan to Watch / Dropped labels.',
      icon: <Check className='w-4 h-4' />,
      count: stats?.watch_statuses_count ?? 0,
      unit: 'labels',
      clearFn: api.clearAllWatchStatuses,
      clearQueryKeys: ['watch-statuses'],
    },
  ];

  const handleExport = async () => {
    setExporting(true);
    try {
      const selected = await saveDialog({
        title: 'Export Streamy Backup',
        defaultPath: `streamy-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;
      const pickedPath = Array.isArray(selected) ? selected[0] : selected;
      const path = pickedPath?.toLowerCase().endsWith('.json') ? pickedPath : `${pickedPath}.json`;
      if (!path) return;

      await api.exportAppDataToFile(path);
      toast.success('Backup exported successfully');
    } catch (err) {
      toast.error(`Export failed: ${getErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImportClick = async () => {
    setImporting(true);
    try {
      const selected = await openDialog({
        title: 'Import Streamy Backup',
        multiple: false,
        directory: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;

      const result = await api.importAppDataFromFile(path);
      for (const key of [
        'continue-watching',
        'watch-history',
        'library',
        'lists',
        'watch-statuses',
        'dataStats',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      refetchStats();
      const historyCount = result?.history_imported ?? 0;
      const libraryCount = result?.library_imported ?? 0;
      const listsCount = result?.lists_imported ?? 0;
      const statusesCount = result?.statuses_imported ?? 0;
      toast.success('Backup imported', {
        description: `${historyCount} history · ${libraryCount} library · ${listsCount} lists · ${statusesCount} statuses`,
      });
    } catch (err) {
      toast.error(`Import failed: ${getErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className='space-y-4'>
      {/* Backup & Restore */}
      <div className='rounded-md border border-white/[0.06] bg-white/[0.015] overflow-hidden'>
        <div className='px-5 py-4 border-b border-white/5 flex items-start gap-3'>
          <Database className='w-4 h-4 text-zinc-500 flex-shrink-0 mt-0.5' />
          <div>
            <h2 className='text-sm font-semibold text-white'>Backup &amp; Restore</h2>
            <p className='text-[11px] text-zinc-500 mt-0.5 leading-relaxed'>
              Export all your data to a single <span className='text-zinc-400'>.json</span> file, or
              restore from a previous backup. Import is non-destructive — existing data is never
              overwritten.
            </p>
          </div>
        </div>
        <div className='px-5 py-4 flex items-center gap-3 flex-wrap'>
          <Button
            size='sm'
            variant='outline'
            onClick={handleExport}
            disabled={exporting || importing}
            className='h-8 px-4 text-xs font-semibold gap-1.5 border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-white'
          >
            {exporting ? (
              <Loader2 className='w-3 h-3 animate-spin' />
            ) : (
              <Download className='w-3 h-3' />
            )}
            Export Backup
          </Button>
          <Button
            size='sm'
            variant='outline'
            onClick={handleImportClick}
            disabled={importing || exporting}
            className='h-8 px-4 text-xs font-semibold gap-1.5 border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-white'
          >
            {importing ? (
              <Loader2 className='w-3 h-3 animate-spin' />
            ) : (
              <Upload className='w-3 h-3' />
            )}
            Import Backup
          </Button>
          <p className='text-[10px] text-zinc-700 flex-1'>Data is stored locally on this device.</p>
        </div>
      </div>

      {/* Data Manager */}
      <div className='rounded-md border border-white/[0.06] bg-white/[0.015] overflow-hidden'>
        <div className='px-5 py-4 border-b border-white/5 flex items-start gap-3'>
          <Database className='w-4 h-4 text-zinc-500 flex-shrink-0 mt-0.5' />
          <div>
            <h2 className='text-sm font-semibold text-white'>Data Manager</h2>
            <p className='text-[11px] text-zinc-500 mt-0.5 leading-relaxed'>
              View and clear locally stored app data. These actions are permanent and cannot be
              undone.
            </p>
          </div>
        </div>

        <div className='px-5 py-4 space-y-3'>
          {categories.map((cat) => {
            const isPending = clearMutation.isPending && clearMutation.variables?.key === cat.key;
            const isConfirming = confirmKey === cat.key;
            const isEmpty = cat.count === 0;

            return (
              <div
                key={cat.key}
                className='flex items-center justify-between gap-4 rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-3'
              >
                <div className='flex items-center gap-3 min-w-0'>
                  <div className='w-8 h-8 rounded-md bg-white/5 flex items-center justify-center text-zinc-500 flex-shrink-0'>
                    {cat.icon}
                  </div>
                  <div className='min-w-0'>
                    <div className='flex items-center gap-2'>
                      <span className='text-sm font-semibold text-white'>{cat.label}</span>
                      {statsLoading ? (
                        <span className='text-[10px] text-zinc-600 animate-pulse'>loading…</span>
                      ) : (
                        <span
                          className={cn(
                            'text-[10px] font-bold px-1.5 py-0.5 rounded-sm tabular-nums',
                            isEmpty
                              ? 'text-zinc-600 bg-white/[0.03]'
                              : 'text-zinc-400 bg-white/[0.06]',
                          )}
                        >
                          {cat.count} {cat.unit}
                        </span>
                      )}
                    </div>
                    <p className='text-[11px] text-zinc-600 truncate leading-none mt-0.5'>
                      {cat.description}
                    </p>
                  </div>
                </div>

                <div className='flex items-center gap-2 flex-shrink-0'>
                  {isConfirming ? (
                    <>
                      <span className='text-[11px] text-zinc-400 flex items-center gap-1'>
                        <AlertTriangle className='w-3 h-3 text-amber-400' />
                        Confirm?
                      </span>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => setConfirmKey(null)}
                        className='h-7 px-3 text-xs'
                      >
                        Cancel
                      </Button>
                      <Button
                        size='sm'
                        onClick={() => clearMutation.mutate(cat)}
                        disabled={isPending}
                        className='h-7 px-3 text-xs bg-red-500/90 hover:bg-red-500 text-white border-0'
                      >
                        {isPending ? <Loader2 className='w-3 h-3 animate-spin' /> : 'Clear'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => {
                        if (!isEmpty) setConfirmKey(cat.key);
                      }}
                      disabled={isEmpty || clearMutation.isPending}
                      className={cn(
                        'h-7 px-3 text-xs font-semibold',
                        isEmpty
                          ? 'opacity-30 cursor-not-allowed'
                          : 'border-red-500/20 text-red-400 hover:bg-red-500/10 hover:text-red-300',
                      )}
                    >
                      <Trash2 className='w-3 h-3 mr-1' />
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            );
          })}

          <p className='text-[10px] text-zinc-700 px-1 pt-1'>
            Streaming sources and playback preferences are managed separately and are not affected
            here.
          </p>
        </div>
      </div>
    </div>
  );
}
