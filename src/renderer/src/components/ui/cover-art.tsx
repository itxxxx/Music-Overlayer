import { AnimatePresence, motion } from 'framer-motion'
import { Music2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CoverArtProps {
  src: string | null
  className?: string
  iconClassName?: string
}

/** Album artwork with a crossfade between tracks and a quiet placeholder when there is none. */
export function CoverArt({ src, className, iconClassName }: CoverArtProps) {
  return (
    <div className={cn('relative shrink-0 overflow-hidden bg-white/10', className)}>
      <AnimatePresence initial={false}>
        {src ? (
          <motion.img
            key={src}
            src={src}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          />
        ) : (
          <motion.div
            key="placeholder"
            className="absolute inset-0 grid place-items-center bg-gradient-to-br from-white/16 to-white/4 text-white/55"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Music2 className={cn('size-5', iconClassName)} strokeWidth={2.2} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
