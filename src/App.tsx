import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import ActivityDetail from './pages/ActivityDetail'
import Profile from './pages/Profile'
import Goals from './pages/Goals'
import WeeklyPlan from './pages/WeeklyPlan'
import Chat from './pages/Chat'
import BottomNav from './components/BottomNav'

const NO_NAV_PATHS = ['/', '/auth/callback']

function Layout() {
  const { pathname } = useLocation()
  const showNav = !NO_NAV_PATHS.includes(pathname)

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
