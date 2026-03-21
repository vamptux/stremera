import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MediaItem, api, getErrorMessage } from '@/lib/api';
import { useDebounce } from '@/hooks/use-debounce';
import { Search, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

interface SearchMediaDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (item: MediaItem) => void;
}

export function SearchMediaDialog({ open, onOpenChange, onSelect }: SearchMediaDialogProps) {
    const [query, setQuery] = useState('');
    const debouncedQuery = useDebounce(query, 500);
    const [type, setType] = useState<'all' | 'anime'>('all');
    const [results, setResults] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!debouncedQuery.trim()) {
            setResults([]);
            return;
        }

        let cancelled = false;

        async function search() {
            setLoading(true);
            try {
                let data: MediaItem[] = [];
                if (type === 'anime') {
                    data = await api.searchKitsu(debouncedQuery);
                } else {
                    data = await api.searchMedia(debouncedQuery);
                }
                if (cancelled) return;
                setResults(data || []);
            } catch (error) {
                if (!cancelled) {
                    toast.error('Failed to search', { description: getErrorMessage(error) });
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }
        search();

        return () => {
            cancelled = true;
        };
    }, [debouncedQuery, type]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl h-[80vh] flex flex-col p-0 gap-0 bg-zinc-950 border-zinc-800">
                <div className="p-4 border-b border-white/10 space-y-4">
                    <DialogHeader>
                        <DialogTitle>Add to List</DialogTitle>
                    </DialogHeader>
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input 
                                placeholder="Search movies, series, anime..." 
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                className="pl-9 bg-zinc-900 border-white/10"
                                autoFocus
                            />
                        </div>
                        <Tabs value={type} onValueChange={(v) => setType(v as 'all' | 'anime')}>
                            <TabsList>
                                <TabsTrigger value="all">All</TabsTrigger>
                                <TabsTrigger value="anime">Anime</TabsTrigger>
                            </TabsList>
                        </Tabs>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
                    {loading ? (
                        <div className="flex justify-center py-8">
                            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : results.length > 0 ? (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-4">
                            {results.map((item) => (
                                <div 
                                    key={item.id} 
                                    className="group relative cursor-pointer space-y-2"
                                    onClick={() => onSelect(item)}
                                >
                                    <div className="aspect-[2/3] rounded-lg overflow-hidden bg-zinc-900 relative">
                                        {item.poster ? (
                                            <img src={item.poster} alt={item.title} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-xs text-center p-2 text-muted-foreground">
                                                {item.title}
                                            </div>
                                        )}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                            <Plus className="w-8 h-8 text-white" />
                                        </div>
                                    </div>
                                    <div className="text-xs font-medium truncate text-zinc-300 group-hover:text-white">{item.title}</div>
                                </div>
                            ))}
                        </div>
                    ) : query ? (
                        <div className="text-center py-8 text-muted-foreground">No results found</div>
                    ) : (
                        <div className="text-center py-8 text-muted-foreground">Start typing to search...</div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
