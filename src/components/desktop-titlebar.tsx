import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { cn } from '@/lib/utils';

/** Routes where a back button should appear in the titlebar. */
function canGoBack(pathname: string): boolean {
  return pathname.startsWith('/details/');
}

interface DesktopTitlebarProps {
  className?: string;
}

export function DesktopTitlebar({ className }: DesktopTitlebarProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktopRuntime = isTauriDesktopRuntime();
  const appWindow = useMemo(
    () => (isDesktopRuntime ? getCurrentWindow() : null),
    [isDesktopRuntime],
  );
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;

    let isActive = true;
    let unlisten: (() => void) | undefined;

    const syncWindowState = async () => {
      try {
        const nextValue = await appWindow.isMaximized();
        if (isActive) {
          setIsMaximized(nextValue);
        }
      } catch {
        if (isActive) {
          setIsMaximized(false);
        }
      }
    };

    void syncWindowState();
    void appWindow
      .onResized(() => {
        void syncWindowState();
      })
      .then((dispose) => {
        if (!isActive) {
          dispose();
          return;
        }

        unlisten = dispose;
      });

    return () => {
      isActive = false;
      unlisten?.();
    };
  }, [appWindow]);

  const showBack = canGoBack(location.pathname);

  const handleBack = () => {
    const from = (location.state as { from?: string } | undefined)?.from;
    if (
      typeof from === 'string' &&
      from.length > 0 &&
      from.startsWith('/') &&
      !from.startsWith('/player')
    ) {
      navigate(from, { replace: true });
      return;
    }
    navigate('/', { replace: true });
  };

  const handleToggleMaximize = () => {
    if (!appWindow) return;
    void appWindow.toggleMaximize();
  };

  return (
    <div className={cn('fixed inset-x-0 top-0 z-[80] flex h-8 items-stretch', className)}>
      {/* Back button — only on detail-type routes */}
      {showBack && (
        <button
          type='button'
          onClick={handleBack}
          className='flex h-full w-12 items-center justify-center text-white/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white'
          aria-label='Go back'
        >
          <ArrowLeft className='h-4 w-4' strokeWidth={2} />
        </button>
      )}

      {/* Drag region fills remaining space */}
      <button
        type='button'
        data-tauri-drag-region
        aria-label='Toggle maximize window'
        className='flex min-w-0 flex-1 items-center select-none focus:outline-none'
        onDoubleClick={handleToggleMaximize}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return;
          }

          event.preventDefault();
          handleToggleMaximize();
        }}
      />

      {/* Window controls — flush right */}
      <div className='flex items-stretch'>
        <TitlebarButton
          label='Minimize'
          onClick={() => {
            if (!appWindow) return;
            void appWindow.minimize();
          }}
          disabled={!appWindow}
        >
          <Minus className='h-3.5 w-3.5' strokeWidth={2} />
        </TitlebarButton>
        <TitlebarButton
          label={isMaximized ? 'Restore' : 'Maximize'}
          onClick={handleToggleMaximize}
          disabled={!appWindow}
        >
          {isMaximized ? (
            <Minimize2 className='h-3.5 w-3.5' strokeWidth={2} />
          ) : (
            <Maximize2 className='h-3.5 w-3.5' strokeWidth={2} />
          )}
        </TitlebarButton>
        <TitlebarButton
          label='Close'
          onClick={() => {
            if (!appWindow) return;
            void appWindow.close();
          }}
          disabled={!appWindow}
          tone='danger'
        >
          <X className='h-3.5 w-3.5' strokeWidth={2} />
        </TitlebarButton>
      </div>
    </div>
  );
}

interface TitlebarButtonProps {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
}

function TitlebarButton({
  children,
  disabled,
  label,
  onClick,
  tone = 'default',
}: TitlebarButtonProps) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-full w-12 items-center justify-center text-white/70 transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-30',
        tone === 'danger'
          ? 'hover:bg-red-500/80 hover:text-white'
          : 'hover:bg-white/[0.1] hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
