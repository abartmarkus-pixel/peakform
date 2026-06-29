import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconHome, IconPlan, IconChat, IconGoals, IconProfile,
} from '../lib/icons'

const TABS = [
  { path: '/dashboard', Icon: IconHome,    label: 'Home'   },
  { path: '/plan',      Icon: IconPlan,    label: 'Plan'   },
  { path: '/chat',      Icon: IconChat,    label: 'Coach'  },
  { path: '/goals',     Icon: IconGoals,   label: 'Ziele'  },
  { path: '/profile',   Icon: IconProfile, label: 'Profil' },
]

export default function BottomNav() {
  const { pathname } = useLocation()
  const navigate     = useNavigate()

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900 border-t border-slate-800"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex max-w-2xl mx-auto">
        {TABS.map(({ path, Icon, label }) => {
          const active = pathname.startsWith(path)
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={`flex flex-col items-center justify-center gap-1 flex-1 py-2.5 min-h-[48px] active:opacity-70 transition-opacity ${
                active ? 'text-brand-500' : 'text-slate-400'
              }`}
            >
              <Icon size={20} />
              <span className="text-[10px] uppercase tracking-wide font-medium leading-none">
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
