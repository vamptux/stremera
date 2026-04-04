import { useState, type ReactNode } from 'react';
import { getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Loader2,
  Captions,
  Music2,
  Check,
  ChevronDown,
  AlertTriangle,
  Eye,
  EyeOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { usePlaybackLanguagePreferences } from '@/hooks/use-playback-language-preferences';
import { normalizeLanguageToken } from '@/lib/player-track-utils';

// ── Constants ────────────────────────────────────────────────────────────────

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

function normalizePreference(value: string): string {
  return normalizeLanguageToken(value);
}

function formatLanguageLabel(value: string, kind: 'audio' | 'subtitle'): string {
  const normalized = normalizePreference(value);
  if (!normalized) return 'Auto';
  if (kind === 'subtitle' && normalized === 'off') return 'Off';
  const option = LANGUAGE_OPTIONS.find((lang) => lang.value === normalized);
  return option ? `${option.label} (${option.value})` : normalized;
}

// ── Language selector ────────────────────────────────────────────────────────

interface LanguageSelectorProps {
  label: string;
  icon: ReactNode;
  value: string;
  kind: 'audio' | 'subtitle';
  onChange: (value: string) => void;
}

function LanguageSelector({ label, icon, value, kind, onChange }: LanguageSelectorProps) {
  const normalized = normalizePreference(value);

  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest inline-flex items-center gap-1.5">
        {icon} {label}
      </label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between bg-white/[0.03] border-white/[0.07] hover:bg-white/[0.06] hover:border-white/15 text-[13px] font-normal h-8 rounded transition-colors"
          >
            <span className="truncate">{formatLanguageLabel(value, kind)}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0 ml-2" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[var(--radix-dropdown-menu-trigger-width)] bg-zinc-950/95 border-white/10 backdrop-blur-md rounded p-1"
        >
          <DropdownMenuItem onClick={() => onChange('')} className="gap-2.5 py-1.5 text-[13px] rounded cursor-pointer">
            {!normalized ? <Check className="h-3.5 w-3.5 opacity-70" /> : <div className="w-3.5" />}
            Auto
          </DropdownMenuItem>
          {kind === 'subtitle' && (
            <DropdownMenuItem onClick={() => onChange('off')} className="gap-2.5 py-1.5 text-[13px] rounded cursor-pointer">
              {normalized === 'off' ? <Check className="h-3.5 w-3.5 opacity-70" /> : <div className="w-3.5" />}
              Off
            </DropdownMenuItem>
          )}
          {LANGUAGE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onChange(option.value)}
              className="gap-2.5 py-1.5 text-[13px] rounded cursor-pointer"
            >
              {normalized === option.value ? <Check className="h-3.5 w-3.5 opacity-70" /> : <div className="w-3.5" />}
              {option.label} ({option.value})
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── Playback language config ─────────────────────────────────────────────────

function PlaybackLanguageConfig() {
  const [audioLang, setAudioLang] = useState<string | undefined>(undefined);
  const [subtitleLang, setSubtitleLang] = useState<string | undefined>(undefined);
  const [isSavingPlaybackLanguagePreferences, setIsSavingPlaybackLanguagePreferences] =
    useState(false);
  const {
    globalPlaybackLanguagePreferences: currentPrefs,
    isLoadingGlobalPlaybackLanguagePreferences,
    saveGlobalPlaybackLanguagePreferences,
  } = usePlaybackLanguagePreferences();

  const audioValue = audioLang ?? currentPrefs?.preferredAudioLanguage ?? '';
  const subtitleValue = subtitleLang ?? currentPrefs?.preferredSubtitleLanguage ?? '';

  const normalizedAudio = normalizePreference(audioValue);
  const normalizedSubtitle = normalizePreference(subtitleValue);
  const currentAudio = normalizePreference(currentPrefs?.preferredAudioLanguage ?? '');
  const currentSubtitle = normalizePreference(currentPrefs?.preferredSubtitleLanguage ?? '');
  const isDirty = normalizedAudio !== currentAudio || normalizedSubtitle !== currentSubtitle;

  const handleSave = async () => {
    setIsSavingPlaybackLanguagePreferences(true);

    try {
      await saveGlobalPlaybackLanguagePreferences({
        preferredAudioLanguage: normalizedAudio || undefined,
        preferredSubtitleLanguage: normalizedSubtitle || undefined,
      });
      setAudioLang(undefined);
      setSubtitleLang(undefined);
      toast.success('Playback language preferences saved');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsSavingPlaybackLanguagePreferences(false);
    }
  };

  return (
    <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.05]">
        <h3 className="text-[13px] font-semibold text-white flex items-center gap-2">
          <Captions className="w-3.5 h-3.5 text-zinc-500" />
          Audio & Subtitles
        </h3>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          Preferred language codes — player auto-selects matching tracks. Use <span className="text-zinc-400 font-medium">off</span> to disable subtitles.
        </p>
      </div>

      <div className="px-4 py-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LanguageSelector
            label="Audio Language"
            icon={<Music2 className="w-3 h-3" />}
            value={audioValue}
            kind="audio"
            onChange={setAudioLang}
          />
          <LanguageSelector
            label="Subtitle Language"
            icon={<Captions className="w-3 h-3" />}
            value={subtitleValue}
            kind="subtitle"
            onChange={setSubtitleLang}
          />
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-white/[0.05]">
          <div className="text-[12px] text-zinc-500">
            {isDirty && (
              <span className="text-amber-400 font-medium flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" /> Unsaved changes
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setAudioLang(undefined); setSubtitleLang(undefined); }}
              disabled={
                isLoadingGlobalPlaybackLanguagePreferences ||
                isSavingPlaybackLanguagePreferences
              }
              className="h-7 px-3 text-[12px] font-semibold rounded bg-transparent border-white/[0.08] hover:bg-white/[0.06]"
            >
              Revert
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void handleSave();
              }}
              disabled={
                isLoadingGlobalPlaybackLanguagePreferences ||
                !isDirty ||
                isSavingPlaybackLanguagePreferences
              }
              className="h-7 px-4 bg-white text-black hover:bg-zinc-200 rounded text-[12px] font-semibold gap-1.5 shadow-none"
            >
              {isSavingPlaybackLanguagePreferences && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Spoiler protection toggle ────────────────────────────────────────────────

function SpoilerProtectionToggle() {
  const {
    preferences: appUiPreferences,
    updatePreferences,
    isLoading,
    isSaving,
  } = useAppUiPreferences();
  const spoilerProtection = appUiPreferences.spoilerProtection;

  const handleToggle = () => {
    void updatePreferences({ spoilerProtection: !spoilerProtection });
  };

  return (
    <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="text-zinc-400 shrink-0">
            {spoilerProtection ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-white">Spoiler Protection</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Blur episode thumbnails and descriptions for unwatched episodes.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={spoilerProtection}
          aria-disabled={isLoading || isSaving}
          disabled={isLoading || isSaving}
          onClick={handleToggle}
          className={cn(
            'relative inline-flex items-center shrink-0 w-10 h-5 rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20',
            spoilerProtection
              ? 'bg-white border-white/70'
              : 'bg-zinc-800/90 border-white/10 hover:border-white/20',
            (isLoading || isSaving) && 'cursor-not-allowed opacity-60',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full shadow-sm transition-transform duration-150 flex items-center justify-center',
              spoilerProtection
                ? 'translate-x-5 bg-black text-white'
                : 'translate-x-0 bg-white/90 text-zinc-800',
            )}
          >
            {spoilerProtection ? <EyeOff className="w-2 h-2" /> : <Eye className="w-2 h-2" />}
          </span>
        </button>
      </div>
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function PlaybackSettings() {
  return (
    <div className="space-y-4">
      <PlaybackLanguageConfig />
      <SpoilerProtectionToggle />
    </div>
  );
}
