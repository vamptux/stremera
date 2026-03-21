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
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { LIST_ICONS, ListIcon } from './list-icons';
import { cn } from '@/lib/utils';

interface RenameListDialogInnerProps {
  list: UserList;
  onOpenChange: (open: boolean) => void;
  onRenamed?: () => void;
}

// Inner form component — mounted fresh whenever `list` changes (via key prop in parent)
function RenameListDialogInner({ list, onOpenChange, onRenamed }: RenameListDialogInnerProps) {
  const [name, setName] = useState(list.name);
  const [selectedIcon, setSelectedIcon] = useState(list.icon);

  const renameList = useMutation({
    mutationFn: () => api.renameList(list.id, name.trim(), selectedIcon),
    onSuccess: () => {
      toast.success(`List renamed to "${name.trim()}"`);
      onRenamed?.();
      onOpenChange(false);
    },
    onError: () => toast.error('Failed to rename list'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    renameList.mutate();
  };

  const hasChanges = name.trim() !== list.name || selectedIcon !== list.icon;

  return (
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
          onClick={() => onOpenChange(false)}
          className='text-zinc-400 hover:text-white hover:bg-white/5'
        >
          Cancel
        </Button>
        <Button
          type='submit'
          disabled={!name.trim() || !hasChanges || renameList.isPending}
          className='bg-white text-black hover:bg-zinc-200 font-semibold'
        >
          {renameList.isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : 'Save Changes'}
        </Button>
      </DialogFooter>
    </form>
  );
}

interface RenameListDialogProps {
  list: UserList;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed?: () => void;
}

export function RenameListDialog({ list, open, onOpenChange, onRenamed }: RenameListDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-sm bg-zinc-950 border-zinc-800 text-zinc-200'>
        <DialogHeader>
          <DialogTitle className='text-white font-bold'>Edit List</DialogTitle>
        </DialogHeader>
        {/* key={list.id} ensures the inner form remounts with fresh state whenever the list changes */}
        <RenameListDialogInner
          key={list.id}
          list={list}
          onOpenChange={onOpenChange}
          onRenamed={onRenamed}
        />
      </DialogContent>
    </Dialog>
  );
}
