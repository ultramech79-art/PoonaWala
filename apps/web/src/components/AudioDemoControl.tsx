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
        className="fixed left-3 top-[4.65rem] z-[260] h-11 w-14 rounded-full border border-red-200 bg-red-50/95 text-[11px] font-black text-red-700 shadow-lg shadow-red-900/10 backdrop-blur transition active:scale-95"
        title="Audio demo no"
        aria-label="Audio demo no"
      >
        NO
      </button>
      <button
        type="button"
        onClick={() => selectOutcome('pass')}
        className="fixed right-3 top-[4.65rem] z-[260] h-11 w-14 rounded-full border border-emerald-200 bg-emerald-50/95 text-[11px] font-black text-emerald-700 shadow-lg shadow-emerald-900/10 backdrop-blur transition active:scale-95"
        title="Audio demo yes"
        aria-label="Audio demo yes"
      >
        YES
      </button>
    </>
  )
}
