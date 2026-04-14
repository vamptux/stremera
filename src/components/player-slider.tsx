import * as SliderPrimitive from '@radix-ui/react-slider';
import React from 'react';
import { cn } from '@/lib/utils';

export const PlayerSlider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex h-5 w-full touch-none select-none items-center group/slider cursor-pointer',
      className,
    )}
    onClick={(e) => e.stopPropagation()}
    onPointerDown={(e) => e.stopPropagation()}
    {...props}
  >
    <SliderPrimitive.Track className='relative h-[5px] w-full grow overflow-hidden rounded-full bg-white/15 transition-[height] duration-150 group-hover/slider:h-[7px]'>
      <SliderPrimitive.Range className='absolute h-full bg-white' />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className='block h-4 w-4 cursor-pointer opacity-0' />
  </SliderPrimitive.Root>
));

PlayerSlider.displayName = SliderPrimitive.Root.displayName;
