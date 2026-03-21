import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, UserList } from '@/lib/api';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { LIST_ICONS, DEFAULT_LIST_ICON, ListIcon } from './list-icons';
import { cn } from '@/lib/utils';

interface CreateListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (list: UserList) => void;
}

export function CreateListDialog({ open, onOpenChange, onCreated }: CreateListDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [selectedIcon, setSelectedIcon] = useState(DEFAULT_LIST_ICON);

  const createList = useMutation({
    mutationFn: () => api.createList(name.trim(), selectedIcon),
    onSuccess: (newList) => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
      toast.success(`"${newList.name}" created`);
      onCreated?.(newList);
      handleClose();
    },
    onError: () => toast.error('Failed to create list'),
  });

  const handleClose = () => {
    setName('');
    setSelectedIcon(DEFAULT_LIST_ICON);
    onOpenChange(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createList.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='sm:max-w-sm bg-zinc-950 border-zinc-800 text-zinc-200'>
        <DialogHeader>
          <DialogTitle className='text-white font-bold'>Create New List</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='space-y-5 mt-2'>
          {/* Icon picker */}
          <div className='space-y-2'>
            <label className='text-[11px] font-bold text-zinc-500 uppercase tracking-widest'>
              Icon
            </label>
            <div className='grid grid-cols-8 gap-2'>
              {LIST_ICONS.map(({ id, label }) => (
                <button
                  key={id}
                  type='button'
                  title={label}
                  onClick={() => setSelectedIcon(id)}
                  className={cn(
                    'h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-150',
                    selectedIcon === id
                      ? 'bg-white/15 ring-1 ring-white/40 scale-110 text-white'
                      : 'bg-zinc-900 hover:bg-zinc-800 hover:scale-105 text-zinc-500 hover:text-zinc-300',
                  )}
                >
                  <ListIcon iconId={id} size={16} />
                </button>
              ))}
            </div>
          </div>

          {/* Name input */}
          <div className='space-y-2'>
            <label className='text-[11px] font-bold text-zinc-500 uppercase tracking-widest'>
              List Name
            </label>
            <div className='flex items-center gap-2'>
              <div className='h-9 w-9 rounded-lg bg-zinc-900 border border-white/10 flex items-center justify-center text-white shrink-0'>
                <ListIcon iconId={selectedIcon} size={16} />
              </div>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='My Favourites'
                className='bg-zinc-900 border-white/10 focus-visible:ring-white/20 text-white placeholder:text-zinc-600'
                maxLength={40}
                autoFocus
              />
            </div>
          </div>

          <DialogFooter className='gap-2 mt-4'>
            <Button
              type='button'
              variant='ghost'
              onClick={handleClose}
              className='text-zinc-400 hover:text-white hover:bg-white/5'
            >
              Cancel
            </Button>
            <Button
              type='submit'
              disabled={!name.trim() || createList.isPending}
              className='bg-white text-black hover:bg-zinc-200 font-semibold'
            >
              {createList.isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : 'Create List'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
