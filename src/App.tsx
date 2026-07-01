import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import ActivityDetail from './pages/ActivityDetail'
import Profile from './pages/Profile'
import Goals from './pages/Goals'
import WeeklyPlan from './pages/WeeklyPlan'
import Chat from './pages/Chat'
import Onboarding from './pages/Onboarding'
import BottomNav from './components/BottomNav'
import { restoreSessionFromSupabase } from './lib/strava'
import { supabase } from './lib/supabase'

const NO_NAV_PATHS = ['/', '/auth/callback', '/onboarding']
const PUBLIC_PATHS = ['/', '/auth/callback']

function Layout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const showNav = !NO_NAV_PATHS.includes(pathname)

  const isLoggedIn =
    !!localStorage.getItem('athlete_strava_id') ||
    !!sessionStorage.getItem('athlete_strava_id')

  const [showSplash, setShowSplash] = useState(
    isLoggedIn && !PUBLIC_PATHS.includes(window.location.pathname)
  )
  const [fadingOut, setFadingOut] = useState(false)

  useEffect(() => {
    if (PUBLIC_PATHS.includes(window.location.pathname)) return

    const sessionCheck = (async () => {
      let stravaId =
        localStorage.getItem('athlete_strava_id') ||
        sessionStorage.getItem('athlete_strava_id')

      if (stravaId) {
        if (!localStorage.getItem('athlete_strava_id')) {
          localStorage.setItem('athlete_strava_id', stravaId)
        }
      } else {
        const restored = await restoreSessionFromSupabase()
        if (!restored) { navigate('/', { replace: true }); return }
        stravaId =
          localStorage.getItem('athlete_strava_id') ||
          sessionStorage.getItem('athlete_strava_id')
      }

      if (!stravaId || window.location.pathname === '/onboarding') return

      const { data } = await supabase
        .from('athletes')
        .select('onboarding_completed')
        .eq('strava_athlete_id', Number(stravaId))
        .single()

      if (data?.onboarding_completed === false) {
        navigate('/onboarding', { replace: true })
      }
    })()

    if (!isLoggedIn) return

    const minDelay = new Promise<void>(resolve => setTimeout(resolve, 2000))
    Promise.all([minDelay, sessionCheck]).then(() => {
      setFadingOut(true)
      setTimeout(() => setShowSplash(false), 400)
    })
  }, [navigate])

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/activity/:id" element={<ActivityDetail />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/plan" element={<WeeklyPlan />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
      {showNav && <BottomNav />}

      {showSplash && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-slate-900 transition-opacity duration-[400ms] ${fadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        >
          <img
            src="/splash.png"
            alt=""
            className="relative z-10 w-4/5 max-w-sm object-contain splash-pulse"
          />
        </div>
      )}
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}
