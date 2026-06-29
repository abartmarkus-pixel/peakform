import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { STRAVA_AUTH_URL } from '../lib/strava'

export default function Home() {
  const navigate = useNavigate()

  useEffect(() => {
    if (localStorage.getItem('athlete_strava_id') || sessionStorage.getItem('athlete_strava_id')) {
      navigate('/dashboard', { replace: true })
    }
  }, [navigate])

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-between py-12"
      style={{
        backgroundImage: 'url(/splash-bg.jpg)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Logo zentriert */}
      <div className="relative z-10 flex-1 flex items-center justify-center">
        <img
          src="/peakform-logo.png"
          alt="PeakForm"
          className="h-12 w-auto"
          srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
        />
      </div>

      {/* Strava Connect Button + Beschreibung */}
      <div className="relative z-10 w-full max-w-sm px-4 flex flex-col items-center gap-4">
        <a
          href={STRAVA_AUTH_URL}
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
