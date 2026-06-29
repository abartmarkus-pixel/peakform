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
import BottomNav from './components/BottomNav'
import { restoreSessionFromSupabase } from './lib/strava'

const NO_NAV_PATHS = ['/', '/auth/callback']
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
      const stravaId =
        localStorage.getItem('athlete_strava_id') ||
        sessionStorage.getItem('athlete_strava_id')

      if (stravaId) {
        if (!localStorage.getItem('athlete_strava_id')) {
          localStorage.setItem('athlete_strava_id', stravaId)
        }
        return
      }

      const restored = await restoreSessionFromSupabase()
      if (!restored) navigate('/', { replace: true })
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
      </Routes>
      {showNav && <BottomNav />}

      {showSplash && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-slate-900 transition-opacity duration-[400ms] ${fadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        >
          <img
            src="/splash.png"
            alt=""
            className="absolute inset-0 w-full h-full object-contain"
          />
          <img
            src="/peakform-logo.png"
            alt="PeakForm"
            className="relative z-10 h-14 w-auto animate-pulse"
            srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
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
