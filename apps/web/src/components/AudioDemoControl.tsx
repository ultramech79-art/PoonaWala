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
        className="fixed left-2 top-[4.65rem] z-[260] h-16 w-20 rounded-full border border-transparent bg-transparent text-transparent shadow-none outline-none"
        aria-label="Audio demo no"
      />
      <button
        type="button"
        onClick={() => selectOutcome('pass')}
        className="fixed right-2 top-[4.65rem] z-[260] h-16 w-20 rounded-full border border-transparent bg-transparent text-transparent shadow-none outline-none"
        aria-label="Audio demo yes"
      />
    </>
  )
}
