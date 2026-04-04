interface ShortcutRow {
  label: string;
  keys: string[];
}

const PLAYER_SHORTCUTS: ShortcutRow[] = [
  { label: 'Play / Pause', keys: ['Space', 'K'] },
  { label: 'Seek backward 10 s', keys: ['←', 'J'] },
  { label: 'Seek forward 10 s', keys: ['→', 'L'] },
  { label: 'Volume up', keys: ['↑'] },
  { label: 'Volume down', keys: ['↓'] },
  { label: 'Toggle fullscreen', keys: ['F'] },
  { label: 'Mute / Unmute', keys: ['M'] },
  { label: 'Next episode', keys: ['N'] },
  { label: 'Download stream', keys: ['D'] },
];

export function ShortcutsSection() {
  return (
    <div className="rounded border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.05]">
        <h3 className="text-[13px] font-semibold text-white">Video Player</h3>
        <p className="text-[11px] text-zinc-500 mt-0.5">Active during playback.</p>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {PLAYER_SHORTCUTS.map(({ label, keys }) => (
          <div key={label} className="flex items-center justify-between py-2 px-4">
            <span className="text-[13px] text-zinc-300">{label}</span>
            <div className="flex items-center gap-1">
              {keys.map((key, i) => (
                <span key={i} className="flex items-center gap-1">
                  <kbd className="inline-flex items-center justify-center min-w-[1.6rem] h-5 px-1.5 rounded bg-zinc-800 border border-white/10 text-[10px] font-mono text-zinc-300 shadow-sm select-none">
                    {key}
                  </kbd>
                  {i < keys.length - 1 && <span className="text-[10px] text-zinc-600">/</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
