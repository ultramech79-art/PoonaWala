import {
  type AudioDemoOutcome,
  writeAudioDemoOverride,
} from '../lib/audioDemoOverride'

interface AudioDemoControlProps {
  onOutcomeSelect?: (outcome: AudioDemoOutcome, updatedAt: number) => void
}

export function AudioDemoControl({ onOutcomeSelect }: AudioDemoControlProps) {
  if (!import.meta.env.DEV) return null

  function selectOutcome(outcome: 'pass' | 'fail') {
    const next = writeAudioDemoOverride(outcome)
    onOutcomeSelect?.(outcome, next.updatedAt)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => selectOutcome('fail')}
        className="absolute left-0 top-1/2 z-[260] h-7 w-7 -translate-y-1/2 rounded-full border border-stone-200 bg-white/90 shadow-md backdrop-blur transition active:scale-95"
        title="Audio demo no"
        aria-label="Audio demo no"
      />
      <button
        type="button"
        onClick={() => selectOutcome('pass')}
        className="absolute right-0 top-1/2 z-[260] h-7 w-7 -translate-y-1/2 rounded-full border border-stone-200 bg-white/90 shadow-md backdrop-blur transition active:scale-95"
        title="Audio demo yes"
        aria-label="Audio demo yes"
      />
    </>
  )
}
