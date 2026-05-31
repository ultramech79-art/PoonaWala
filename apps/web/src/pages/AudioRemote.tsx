import { useState } from 'react'
import { Check, X } from 'lucide-react'
import {
  REMOTE_AUDIO_DEMO_CHANNEL,
  type RemoteAudioDemoOutcome,
  sendRemoteAudioDemoCommand,
} from '../lib/audioDemoOverride'

export function AudioRemote() {
  const [status, setStatus] = useState('')
  const [busyOutcome, setBusyOutcome] = useState<RemoteAudioDemoOutcome | null>(null)

  async function send(outcome: RemoteAudioDemoOutcome) {
    setBusyOutcome(outcome)
    setStatus('')
    try {
      await sendRemoteAudioDemoCommand(REMOTE_AUDIO_DEMO_CHANNEL, outcome)
      setStatus(outcome === 'pass' ? 'Yes sent' : 'No sent')
    } catch (error: any) {
      setStatus(error?.message || 'Send failed')
    } finally {
      setBusyOutcome(null)
    }
  }

  return (
    <div className="page bg-stone-50">
      <div className="page-header">
        <div className="w-11" />
        <div className="flex flex-col items-center">
          <span className="text-xs text-stone-400 uppercase tracking-widest font-medium">Audio Remote</span>
          <span className="text-sm font-semibold text-stone-900 mt-0.5">Demo Control</span>
        </div>
        <div className="w-11" />
      </div>

      <div className="flex flex-1 flex-col justify-center gap-5 px-5 py-8">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => send('fail')}
            disabled={busyOutcome !== null}
            className="flex min-h-28 items-center justify-center gap-2 rounded-2xl bg-red-600 px-5 py-5 text-lg font-black text-white shadow-lg shadow-red-600/20 transition active:scale-[0.98] disabled:opacity-50"
          >
            <X className="h-5 w-5" />
            NO
          </button>
          <button
            type="button"
            onClick={() => send('pass')}
            disabled={busyOutcome !== null}
            className="flex min-h-28 items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-5 text-lg font-black text-white shadow-lg shadow-emerald-600/20 transition active:scale-[0.98] disabled:opacity-50"
          >
            <Check className="h-5 w-5" />
            YES
          </button>
        </div>

        {status && (
          <p className="rounded-2xl border border-stone-200 bg-white px-4 py-3 text-center text-sm font-semibold text-stone-700">
            {status}
          </p>
        )}
      </div>
    </div>
  )
}
