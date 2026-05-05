import React, { useState, useRef } from 'react'
import { motion, useMotionValue, useTransform, useAnimation } from 'framer-motion'
import { ChevronRight } from 'lucide-react'

interface SwipeButtonProps {
  onSwipeComplete: () => void
  text?: string
}

export function SwipeButton({ onSwipeComplete, text = "Get Started" }: SwipeButtonProps) {
  const [isComplete, setIsComplete] = useState(false)
  const constraintsRef = useRef(null)
  const x = useMotionValue(0)
  
  // Map x position to opacity and width of the track highlights
  const opacity = useTransform(x, [0, 200], [1, 0])
  const scale = useTransform(x, [0, 200], [1, 1.1])
  
  const controls = useAnimation()

  const handleDragEnd = async (_: any, info: any) => {
    if (info.offset.x > 180) {
      setIsComplete(true)
      await controls.start({ x: 230, transition: { duration: 0.2 } })
      onSwipeComplete()
    } else {
      controls.start({ x: 0, transition: { type: 'spring', stiffness: 300, damping: 30 } })
    }
  }

  return (
    <div className="relative w-full h-16 bg-gradient-to-r from-brand-700 to-brand-800 rounded-full p-1.5 overflow-hidden shadow-xl border border-white/10">
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <motion.span 
          style={{ opacity }}
          className="text-white/80 font-display font-bold text-lg tracking-wider"
        >
          {text}
        </motion.span>
      </div>
      
      <div ref={constraintsRef} className="relative w-full h-full">
        <motion.div
          drag="x"
          dragConstraints={{ left: 0, right: 230 }}
          dragElastic={0.05}
          dragMomentum={false}
          onDragEnd={handleDragEnd}
          animate={controls}
          style={{ x }}
          className="absolute left-0 top-1/2 -translate-y-1/2 w-13 h-13 rounded-full bg-white flex items-center justify-center cursor-grab active:cursor-grabbing shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-10"
        >
          <ChevronRight className="w-7 h-7 text-brand-700" strokeWidth={3} />
        </motion.div>
        
        {/* Modern Arrow indicators */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-0.5 pointer-events-none opacity-40">
          <motion.div
            animate={{ x: [0, 8, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
          >
            <ChevronRight className="w-5 h-5 text-white" strokeWidth={3} />
          </motion.div>
          <motion.div
            animate={{ x: [0, 8, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
            className="-ml-3"
          >
            <ChevronRight className="w-5 h-5 text-white" strokeWidth={3} />
          </motion.div>
        </div>
      </div>
    </div>
  )
}
