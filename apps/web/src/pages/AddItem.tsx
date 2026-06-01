import { useNavigate } from 'react-router-dom'
import { Plus, ArrowRight, User } from 'lucide-react'
import { useSessionStore } from '../store/session'

export function AddItem() {
  const navigate = useNavigate()
  const { state } = useSessionStore()

  return (
    <div className="page app-page-bg flex flex-col min-h-dvh relative">

      {/* Header */}
      <div className="px-5 py-3 flex justify-end">
        <button
          onClick={() => state.authToken && state.authToken !== 'guest' ? navigate('/dashboard-home') : navigate('/login')}
          className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
        >
          <User className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col justify-center px-6 gap-3">

        {/* Add new item */}
        <button
          onClick={() => navigate('/setup')}
          className="w-full rounded-3xl bg-stone-950 p-6 flex items-center justify-between active:scale-[0.98] transition-transform group"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0">
              <Plus className="w-6 h-6 text-white stroke-[2.5]" />
            </div>
            <div className="text-left">
              <p className="text-white font-bold text-base tracking-tight">Add another item</p>
              <p className="text-white/40 text-xs mt-0.5">Start a new jewellery evaluation</p>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-white/30" />
        </button>

        {/* Continue evaluation */}
        <button
          onClick={() => navigate('/processing')}
          className="w-full rounded-3xl bg-white border border-stone-200 p-6 flex items-center justify-between active:scale-[0.98] transition-transform group shadow-sm"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center flex-shrink-0">
              <ArrowRight className="w-6 h-6 text-stone-700" />
            </div>
            <div className="text-left">
              <p className="text-stone-950 font-bold text-base tracking-tight">Continue evaluation</p>
              <p className="text-stone-400 text-xs mt-0.5">Weight estimate and final result</p>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-stone-300" />
        </button>

      </div>

    </div>
  )
}
