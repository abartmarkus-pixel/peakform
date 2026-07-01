import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { generateOAuthState, getStravaAuthUrl } from '../lib/strava'

export default function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const [authUrl, setAuthUrl] = useState<string>('#')
  const loginError = (location.state as { error?: string } | null)?.error ?? null

  useEffect(() => {
    if (localStorage.getItem('athlete_strava_id') || sessionStorage.getItem('athlete_strava_id')) {
      navigate('/dashboard', { replace: true })
    }
  }, [navigate])

  useEffect(() => {
    setAuthUrl(getStravaAuthUrl(generateOAuthState()))
  }, [])

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-between py-12">
      <div className="flex-1 flex items-center justify-center">
        <img
          src="/peakform-logo.png"
          alt="PeakForm"
          className="h-12 w-auto"
          srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
        />
      </div>

      <div className="w-full max-w-sm px-4 flex flex-col items-center gap-4">
        {loginError && (
          <p className="w-full text-red-400 text-sm text-center bg-red-950/40 border border-red-500/30 rounded-lg px-4 py-2">
            {loginError}
          </p>
        )}
        <a
          href={authUrl}
          className="flex items-center gap-3 bg-[#FC4C02] hover:bg-[#e04400] text-white font-semibold px-6 py-3 rounded-xl transition-colors"
        >
          <img
            src="https://upload.wikimedia.org/wikipedia/commons/c/cb/Strava_Logo.svg"
            alt=""
            className="h-5 brightness-0 invert"
          />
          Mit Strava verbinden
        </a>

        <p className="text-white/70 text-sm text-center">
          PeakForm liest deine Trainingsaktivitäten und erstellt KI-basierte Analysen
          mit Claude von Anthropic.
        </p>
      </div>
    </div>
  )
}
