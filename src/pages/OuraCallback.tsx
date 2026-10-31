import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { connectOura, syncOuraData } from '../lib/oura'

// Rücksprung nach der Oura-Anmeldung (analog AuthCallback.tsx für Strava). Der Athlet ist
// hier bereits in PeakForm eingeloggt — Oura wird nur zusätzlich verbunden.
export default function OuraCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false) // Auth-Code ist einmalig — StrictMode-Doppelaufruf verhindern

  useEffect(() => {
    if (started.current) return
    started.current = true

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const receivedState = params.get('state')
    const expectedState = sessionStorage.getItem('oura_oauth_state')
    sessionStorage.removeItem('oura_oauth_state')

    if (params.get('error')) { setError('Oura-Verbindung abgebrochen.'); return }
    if (!code) { setError('Kein Autorisierungscode erhalten.'); return }
    if (!receivedState || receivedState !== expectedState) {
      setError('Verbindung fehlgeschlagen. Bitte erneut versuchen.')
      return
    }

    const stravaId = localStorage.getItem('athlete_strava_id') || sessionStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/', { replace: true }); return }

    ;(async () => {
      try {
        const { data } = await supabase.from('athletes').select('id').eq('strava_athlete_id', Number(stravaId)).single()
        if (!data) throw new Error('Athlet nicht gefunden')
        await connectOura(data.id, code)
        await syncOuraData(data.id)
        navigate('/profile', { replace: true })
      } catch (err) {
        console.error(err)
        setError('Verbindung zu Oura fehlgeschlagen. Bitte versuche es erneut.')
      }
    })()
  }, [navigate])

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4 text-center">
        <p className="text-red-400">{error}</p>
        <a href="/profile" className="text-brand-500 underline">Zurück zum Profil</a>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400">Verbinde mit Oura…</p>
      </div>
    </div>
  )
}
