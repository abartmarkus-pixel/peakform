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
  const [sessionReady, setSessionReady] = useState(() => PUBLIC_PATHS.includes(pathname))
  const [fadingOut, setFadingOut] = useState(false)

  useEffect(() => {
    if (PUBLIC_PATHS.includes(window.location.pathname)) return

    const stravaId =
      localStorage.getItem('athlete_strava_id') ||
      sessionStorage.getItem('athlete_strava_id')

    function dismissSplash() {
      setFadingOut(true)
      setTimeout(() => setSessionReady(true), 300)
    }

    if (stravaId) {
      if (!localStorage.getItem('athlete_strava_id')) {
        localStorage.setItem('athlete_strava_id', stravaId)
      }
      dismissSplash()
      return
    }

    restoreSessionFromSupabase().then(restored => {
      if (!restored) navigate('/', { replace: true })
      dismissSplash()
    })
  }, [navigate])

  if (!sessionReady) {
    return (
      <div
        className={`fixed inset-0 flex flex-col items-center justify-center transition-opacity duration-300 ${fadingOut ? 'opacity-0' : 'opacity-100'}`}
        style={{
          backgroundImage: 'url(/splash-bg.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative z-10 flex flex-col items-center gap-8">
          <img
            src="/peakform-logo.png"
            alt="PeakForm"
            className="h-12 w-auto"
            srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
          />
          <div className="flex gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:0ms]" />
            <div className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:150ms]" />
            <div className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:300ms]" />
          </div>
        </div>
      </div>
    )
  }

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
