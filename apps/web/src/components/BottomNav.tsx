import { useNavigate, useLocation } from 'react-router-dom'
import { Home, ScanLine, Bell, User, Crosshair } from 'lucide-react'
import { clsx } from 'clsx'

const NAV_ITEMS = [
  { icon: Home, label: 'Home', path: '/dashboard' },
  { icon: Crosshair, label: 'Assess', path: '/setup' },
  { icon: ScanLine, label: 'Scan', path: '/capture' },
  { icon: Bell, label: 'Alerts', path: '#' },
  { icon: User, label: 'Profile', path: '#' },
]

export function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map(({ icon: Icon, label, path }) => {
        const active = pathname === path || (path !== '/dashboard' && pathname.startsWith(path))
        return (
          <button
            key={label}
            onClick={() => path !== '#' && navigate(path)}
            className="flex flex-col items-center gap-1 px-3 py-1 min-w-[52px]"
          >
            <div className={clsx(
              'w-10 h-10 rounded-2xl flex items-center justify-center transition-all duration-200',
              active ? 'bg-brand-500 text-white shadow-brand-sm' : 'text-stone-400 hover:text-stone-600'
            )}>
              <Icon className="w-5 h-5" />
            </div>
            <span className={clsx(
              'text-[10px] font-medium transition-colors',
              active ? 'text-brand-600' : 'text-stone-400'
            )}>
              {label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
