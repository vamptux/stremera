import { formatDistanceToNow } from 'date-fns';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { getErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export function UpdatesSection() {
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
  const latestLabel =
    pendingUpdate?.version ??
    (updateState.status === 'up-to-date' ? 'Up to date' : 'No update detected');
  const lastCheckedLabel = updateState.lastCheckedAt
    ? formatDistanceToNow(updateState.lastCheckedAt, { addSuffix: true })
    : 'Not checked yet';

  const statusNote = !isSupported
    ? 'Updater controls are only active inside the packaged desktop app.'
    : isInstalling
      ? (updateState.installStatus ?? 'Applying the update and preparing to relaunch.')
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
      .catch((error) => toast.error(`Update check failed: ${getErrorMessage(error)}`));
  };

  const handleInstall = () => {
    if (!pendingUpdate) return;
    toast.loading('Downloading update…', { id: 'app-update-install' });
    void installUpdate(pendingUpdate, (status) => {
      toast.loading(status, { id: 'app-update-install' });
    }).catch((error) => {
      toast.error(`Update install failed: ${getErrorMessage(error)}`, { id: 'app-update-install' });
    });
  };

  return (
    <div className='space-y-4'>
      {/* Version info */}
      <div
        className={cn(
          'rounded border overflow-hidden transition-colors',
          isUpdateAvailable
            ? 'border-emerald-400/20 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent)]'
            : 'border-white/[0.07] bg-white/[0.02]',
        )}
      >
        <div className='px-4 py-3 border-b border-white/[0.05]'>
          <h3 className='text-[13px] font-semibold text-white'>Version</h3>
          <p className='text-[11px] text-zinc-500 mt-0.5'>
            Signed NSIS releases from GitHub — replaces the current install in place.
          </p>
        </div>

        <div className='px-4 py-4 space-y-3'>
          <div className='grid grid-cols-2 gap-3'>
            <div className='rounded border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5'>
              <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-500'>
                Current
              </p>
              <p className='mt-0.5 text-sm font-semibold text-white tabular-nums'>{currentLabel}</p>
            </div>
            <div className='rounded border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5'>
              <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-500'>
                Latest
              </p>
              <p className='mt-0.5 text-sm font-semibold text-white'>{latestLabel}</p>
              <p className='mt-0.5 text-[10px] text-zinc-500'>Checked {lastCheckedLabel}</p>
            </div>
          </div>

          {updateState.errorMessage && !isUpdateAvailable && (
            <div className='rounded border border-red-500/20 bg-red-500/5 px-3.5 py-2.5'>
              <p className='text-[10px] font-semibold uppercase tracking-widest text-red-300/80'>
                Error
              </p>
              <p className='mt-0.5 text-[12px] leading-relaxed text-red-100/80'>
                {updateState.errorMessage}
              </p>
            </div>
          )}

          {pendingUpdate?.body && (
            <div className='rounded border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5'>
              <p className='text-[10px] font-semibold uppercase tracking-widest text-zinc-500'>
                Release Notes
              </p>
              <p className='mt-1 text-[12px] leading-relaxed text-zinc-400 whitespace-pre-wrap'>
                {pendingUpdate.body}
              </p>
            </div>
          )}

          <div className='flex items-center gap-2.5 flex-wrap pt-1'>
            <Button
              size='sm'
              variant='outline'
              onClick={handleCheck}
              disabled={!isSupported || isChecking || isInstalling}
              className='h-7 px-3.5 text-[12px] font-semibold gap-1.5 border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-white rounded'
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
                'h-7 px-3.5 text-[12px] font-semibold gap-1.5 text-black hover:bg-zinc-200 rounded',
                isUpdateAvailable ? 'bg-emerald-300 hover:bg-emerald-200' : 'bg-white',
              )}
            >
              {isInstalling ? (
                <Loader2 className='w-3 h-3 animate-spin' />
              ) : (
                <Download className='w-3 h-3' />
              )}
              Install & Restart
            </Button>

            <p className='text-[10px] text-zinc-500 flex-1'>{statusNote}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
