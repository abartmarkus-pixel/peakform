import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { exchangeCodeForToken } from '../lib/strava'
import { supabase } from '../lib/supabase'

export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const errorParam = params.get('error')

    if (errorParam) {
      setError('Strava-Verbindung abgebrochen.')
      return
    }
    if (!code) {
      setError('Kein Autorisierungscode erhalten.')
      return
    }

    exchangeCodeForToken(code)
      .then(async (token) => {
        const { error: dbError } = await supabase.from('athletes').upsert(
          {
            strava_athlete_id: token.athlete.id,
            strava_access_token: token.access_token,
            strava_refresh_token: token.refresh_token,
            expires_at: new Date(token.expires_at * 1000).toISOString(),
          },
          { onConflict: 'strava_athlete_id' },
        )
        if (dbError) throw dbError
        localStorage.setItem('athlete_strava_id', String(token.athlete.id))
        navigate('/dashboard')
      })
      .catch((err) => {
        console.error(err)
        setError('Verbindung zu Strava fehlgeschlagen. Bitte versuche es erneut.')
      })
  }, [navigate])

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-red-400">{error}</p>
        <a href="/" className="text-brand-500 underline">Zurück zur Startseite</a>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400">Verbinde mit Strava…</p>
      </div>
    </div>
  )
}
