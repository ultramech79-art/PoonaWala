import {
  type AudioDemoOutcome,
  writeAudioDemoOverride,
} from '../lib/audioDemoOverride'

interface AudioDemoControlProps {
  onOutcomeSelect?: (outcome: AudioDemoOutcome, updatedAt: number) => void
}

export function AudioDemoControl({ onOutcomeSelect }: AudioDemoControlProps) {
  function selectOutcome(outcome: 'pass' | 'fail') {
    const next = writeAudioDemoOverride(outcome)
    onOutcomeSelect?.(outcome, next.updatedAt)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => selectOutcome('fail')}
        className="absolute left-0 top-1/2 z-[260] h-9 w-12 -translate-y-1/2 rounded-full border border-red-200 bg-red-50/95 text-[10px] font-black text-red-700 shadow-md backdrop-blur transition active:scale-95"
        title="Audio demo no"
        aria-label="Audio demo no"
      >
        NO
      </button>
      <button
        type="button"
        onClick={() => selectOutcome('pass')}
        className="absolute right-0 top-1/2 z-[260] h-9 w-12 -translate-y-1/2 rounded-full border border-emerald-200 bg-emerald-50/95 text-[10px] font-black text-emerald-700 shadow-md backdrop-blur transition active:scale-95"
        title="Audio demo yes"
        aria-label="Audio demo yes"
      >
        YES
      </button>
    </>
  )
}
