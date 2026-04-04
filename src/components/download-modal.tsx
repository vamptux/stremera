import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { api, getErrorMessage } from '@/lib/api';
import { useDownloads } from '@/contexts/download-context';
import { Folder, Zap, Download, Wifi, X } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';

interface DownloadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  url: string;
  fileName: string;
  poster?: string;
  mediaType?: string;
  mediaId?: string;
  season?: number;
  episode?: number;
  backdrop?: string; // Add backdrop support
}

export function DownloadModal({
  open,
  onOpenChange,
  title,
  url,
  fileName,
  poster,
  mediaType,
  mediaId,
  season,
  episode,
  backdrop,
}: DownloadModalProps) {
  const { startDownload } = useDownloads();
  const [path, setPath] = useState('');
  const [priority, setPriority] = useState('high'); // high = unlimited, medium = 10MB/s, low = 2MB/s

  useEffect(() => {
    if (!open) return;

    let active = true;
    api
      .getDefaultDownloadPath()
      .then((defaultPath) => {
        if (!active) return;
        setPath(defaultPath);
      })
      .catch((error) => {
        if (!active) return;
        toast.error('Failed to load default download path', { description: getErrorMessage(error) });
      });

    return () => {
      active = false;
    };
  }, [open]);

  const handleSelectFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: path,
      });
      if (selected && typeof selected === 'string') {
        setPath(selected);
      }
    } catch (err) {
      toast.error('Failed to open folder picker', { description: getErrorMessage(err) });
    }
  };

  const handleDownload = async () => {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      toast.error('Download path is required');
      return;
    }

    try {
      let bandwidthLimit: number | undefined;
      
      if (priority === 'low') {
        bandwidthLimit = 2 * 1024 * 1024; // 2 MB/s
      } else if (priority === 'medium') {
        bandwidthLimit = 10 * 1024 * 1024; // 10 MB/s
      } else {
        bandwidthLimit = 0; // Unlimited (overrides global)
      }

      await startDownload({
        title,
        url,
        filePath: normalizedPath,
        fileName,
        poster,
        mediaType,
        bandwidthLimit,
        mediaId,
        season,
        episode,
      });
      onOpenChange(false);
    } catch {
      // handled in context
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden bg-zinc-950 border-zinc-800 [&>button]:hidden">
        <div className="relative h-48 w-full">
            <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent z-10" />
            {backdrop ? (
                <img src={backdrop} alt={title} className="w-full h-full object-cover opacity-60" />
            ) : poster ? (
                <div className="w-full h-full relative overflow-hidden">
                    <img src={poster} alt={title} className="w-full h-full object-cover opacity-40 blur-sm scale-110" />
                </div>
            ) : (
                <div className="w-full h-full bg-zinc-900" />
            )}
            
            {/* Custom close button — above all backdrop layers */}
            <button
                onClick={() => onOpenChange(false)}
                className="absolute top-3 right-3 z-30 p-1.5 rounded-full bg-black/40 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                aria-label="Close"
            >
                <X className="w-4 h-4" />
            </button>
            
            <div className="absolute bottom-4 left-6 z-20 flex items-end gap-4">
                {poster && (
                    <img 
                        src={poster} 
                        alt={title} 
                        className="w-24 h-36 rounded-md shadow-2xl border border-white/10 object-cover hidden sm:block" 
                    />
                )}
                <div className="space-y-1 mb-1">
                    <div className="flex items-center gap-2">
                        <Badge variant="outline" className="bg-black/40 backdrop-blur-md border-white/10 text-xs">
                          {mediaType === 'series' ? 'TV Series' : mediaType === 'anime' ? 'Anime' : 'Movie'}
                        </Badge>
                        {season !== undefined && episode !== undefined && (
                            <Badge variant="secondary" className="text-xs bg-primary/20 text-primary border-primary/20">
                                S{season} E{episode}
                            </Badge>
                        )}
                    </div>
                    <DialogTitle className="text-2xl font-bold text-white leading-tight max-w-lg drop-shadow-md">
                        {title}
                    </DialogTitle>
                    <p className="text-zinc-400 text-sm max-w-md truncate">
                        {fileName}
                    </p>
                </div>
            </div>
        </div>

        <ScrollArea className="max-h-[60vh] px-6 py-6 [&>[data-radix-scroll-area-viewport]>div]:!block">
            <div className="grid gap-6">
                <div className="space-y-2">
                    <Label htmlFor="path">Save to</Label>
                    <div className="flex gap-2">
                        <Input
                            id="path"
                            value={path}
                            onChange={(e) => setPath(e.target.value)}
                            className="bg-zinc-800 border-white/10 flex-1 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-inset focus-visible:ring-offset-0"
                        />
                        <Button
                            variant="outline"
                            onClick={handleSelectFolder}
                            className="bg-zinc-800 border-white/10 hover:bg-zinc-700 shrink-0 gap-2"
                            type="button"
                        >
                            <Folder className="h-4 w-4" />
                            Browse
                        </Button>
                    </div>
                </div>

                {/* Priority Selection */}
                <div className="space-y-3">
                    <Label className="text-zinc-400 font-medium flex items-center gap-2">
                        <Zap className="w-4 h-4" /> Download Priority
                    </Label>
                    <div className="grid grid-cols-3 gap-3">
                        <button
                          type="button"
                            onClick={() => setPriority('high')}
                            className={`
                                relative flex flex-col items-center gap-2 p-3 rounded-lg border transition-all
                                ${priority === 'high' 
                                    ? 'bg-primary/10 border-primary/50 text-primary' 
                                    : 'bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:border-zinc-700'}
                            `}
                        >
                            <Zap className="w-5 h-5" />
                            <span className="text-xs font-medium">High (Unlim.)</span>
                        </button>
                        <button
                          type="button"
                            onClick={() => setPriority('medium')}
                            className={`
                                relative flex flex-col items-center gap-2 p-3 rounded-lg border transition-all
                                ${priority === 'medium' 
                                    ? 'bg-blue-500/10 border-blue-500/50 text-blue-400' 
                                    : 'bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:border-zinc-700'}
                            `}
                        >
                            <Wifi className="w-5 h-5" />
                            <span className="text-xs font-medium">Medium (10MB/s)</span>
                        </button>
                        <button
                          type="button"
                            onClick={() => setPriority('low')}
                            className={`
                                relative flex flex-col items-center gap-2 p-3 rounded-lg border transition-all
                              ${priority === 'low' 
                                ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' 
                                    : 'bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:border-zinc-700'}
                            `}
                        >
                            <Download className="w-5 h-5" />
                            <span className="text-xs font-medium">Low (2MB/s)</span>
                        </button>
                    </div>
                </div>
            </div>
        </ScrollArea>

        <div className="p-6 pt-0 flex justify-end gap-3">
            <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-zinc-400 hover:text-white hover:bg-white/5">
                Cancel
            </Button>
            <Button
              onClick={handleDownload}
              className="bg-white text-black hover:bg-zinc-200 px-8"
              disabled={!path.trim()}
            >
                <Download className="w-4 h-4 mr-2" /> Start Download
            </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
