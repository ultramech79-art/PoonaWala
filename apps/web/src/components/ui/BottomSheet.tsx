import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { sheetVariants, EASE } from '../../theme/tokens'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
}

/**
 * Premium bottom sheet for secondary detail (XAI breakdown, consent detail).
 * Scrim dismiss · swipe-down dismiss · respects reduced-motion · safe-area aware.
 */
export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  // Lock body scroll while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[300] flex items-end justify-center"
          initial="initial" animate="enter" exit="exit"
        >
          {/* Scrim */}
          <motion.button
            aria-label="Close"
            onClick={onClose}
            className="absolute inset-0 bg-stone-900/45"
            variants={{ initial: { opacity: 0 }, enter: { opacity: 1 }, exit: { opacity: 0 } }}
            transition={{ duration: 0.25, ease: EASE }}
          />
          {/* Sheet */}
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className="relative w-full max-w-md bg-surface rounded-t-4xl shadow-lg max-h-[88dvh] flex flex-col"
            variants={sheetVariants}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_, info) => { if (info.offset.y > 120) onClose() }}
          >
            {/* Grabber */}
            <div className="flex flex-col items-center pt-3 pb-1 shrink-0">
              <div className="h-1.5 w-10 rounded-full bg-stone-200" />
            </div>
            {title && (
              <div className="flex items-center justify-between px-5 pt-2 pb-3 shrink-0">
                <h3 className="font-display text-lg font-semibold text-stone-900 tracking-[-0.01em]">{title}</h3>
                <button onClick={onClose} className="btn-icon h-9 w-9" aria-label="Close">
                  <X className="h-4 w-4 text-stone-500" />
                </button>
              </div>
            )}
            <div className="px-5 pb-8 overflow-y-auto no-scrollbar" style={{ paddingBottom: 'max(2rem, var(--safe-bottom))' }}>
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
