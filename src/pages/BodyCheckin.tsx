import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Athlete, type BodyCheckin, type AestheticGoals } from '../lib/supabase'
import { canBodyCheckin } from '../lib/features'
import { compressImage, blobToBase64 } from '../lib/imageUtils'
import { KRAFT_COACH_PROMPT } from '../lib/coachPrompt'
import { renderMarkdown } from '../lib/markdown'
import { IconCamera, IconCheck } from '../lib/icons'
import { AppHeader } from '../components/AppHeader'

type Perspective = 'front' | 'side' | 'back'
type UploadedPhoto = { path: string; base64: string }
type ImageInput = { base64: string; mediaType: string; label: string }

const SLOTS: { key: Perspective; label: string }[] = [
  { key: 'front', label: 'Frontal' },
  { key: 'side',  label: 'Seitlich' },
  { key: 'back',  label: 'Hinten' },
]
const SLOT_LABEL: Record<Perspective, string> = { front: 'Frontal', side: 'Seitlich', back: 'Hinten' }

function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function uploadPhoto(athleteId: string, date: string, perspective: Perspective, file: File): Promise<UploadedPhoto> {
  const compressed = await compressImage(file)
  const base64 = await blobToBase64(compressed)
  const res = await fetch('/api/body-checkin-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ athleteId, date, perspective, base64, mediaType: 'image/jpeg' }),
  })
  if (!res.ok) throw new Error('Upload fehlgeschlagen')
  const json = await res.json() as { path: string }
  return { path: json.path, base64 }
}

async function loadPreviousCheckin(athleteId: string, beforeDate: string): Promise<BodyCheckin | null> {
  const { data } = await supabase
    .from('body_checkins')
    .select('*')
    .eq('athlete_id', athleteId)
    .lt('date', beforeDate)
    .order('date', { ascending: false })
    .limit(5)
  const rows = (data ?? []) as BodyCheckin[]
  return rows.find(r => Object.keys(r.photos ?? {}).length > 0) ?? null
}

async function loadPreviousImages(checkin: BodyCheckin): Promise<ImageInput[]> {
  const entries = Object.entries(checkin.photos) as [Perspective, string][]
  if (entries.length === 0) return []

  const res = await fetch('/api/body-checkin-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: entries.map(([, path]) => path) }),
  })
  if (!res.ok) return []
  const json = await res.json() as { urls: Record<string, string> }

  const images: ImageInput[] = []
  for (const [perspective, path] of entries) {
    const url = json.urls[path]
    if (!url) continue
    const blob = await (await fetch(url)).blob()
    const base64 = await blobToBase64(blob)
    images.push({ base64, mediaType: 'image/jpeg', label: `Vorwoche (${checkin.date}) — ${SLOT_LABEL[perspective]}` })
  }
  return images
}

function buildVisionPrompt(athlete: Athlete, hasPrevious: boolean): string {
  const aesthetic = athlete.aesthetic_goals as AestheticGoals | null
  const priorities = aesthetic?.priorities?.length ? aesthetic.priorities.join(' > ') : '—'
  const notes = aesthetic?.notes || 'keine'
  const bodyGoals = athlete.body_goals?.length ? athlete.body_goals.join(', ') : '—'

  return `Ästhetik-Prioritäten (Rangfolge): ${priorities}
Besonderheiten: ${notes}
Körperziel: ${bodyGoals}

Vergleiche die aktuellen Fotos mit den Vorwoche-Fotos${hasPrevious ? '' : ' (nicht vorhanden)'}. Gib konkretes Feedback pro priorisierter Muskelgruppe. ${hasPrevious ? '' : 'Beschreibe den aktuellen Stand als Baseline.'}`
}

export default function BodyCheckin() {
  const navigate = useNavigate()
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [loading, setLoading] = useState(true)

  const [files, setFiles] = useState<Partial<Record<Perspective, File>>>({})
  const [previews, setPreviews] = useState<Partial<Record<Perspective, string>>>({})
  const [weightKg, setWeightKg] = useState('')
  const [notes, setNotes] = useState('')

  const [phase, setPhase] = useState<'idle' | 'uploading' | 'analysing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    const stravaId = localStorage.getItem('athlete_strava_id') || sessionStorage.getItem('athlete_strava_id')
    if (!stravaId) { navigate('/'); return }

    ;(async () => {
      const { data } = await supabase
        .from('athletes')
        .select('*')
        .eq('strava_athlete_id', Number(stravaId))
        .single()
      const a = data as Athlete | null
      if (!a || !canBodyCheckin(a)) { navigate('/dashboard', { replace: true }); return }
      setAthlete(a)
      setLoading(false)
    })()
  }, [navigate])

  function handleFileSelect(perspective: Perspective, file: File | null) {
    if (!file) return
    setFiles(prev => ({ ...prev, [perspective]: file }))
    setPreviews(prev => ({ ...prev, [perspective]: URL.createObjectURL(file) }))
  }

  async function handleSubmit() {
    if (!athlete) return
    const selected = SLOTS.filter(s => files[s.key])
    if (selected.length === 0) return

    setPhase('uploading')
    setError(null)

    let insertedId: string
    const date = todayStr()

    try {
      const uploaded: Partial<Record<Perspective, UploadedPhoto>> = {}
      for (const slot of selected) {
        uploaded[slot.key] = await uploadPhoto(athlete.id, date, slot.key, files[slot.key]!)
      }
      const photos = Object.fromEntries(
        Object.entries(uploaded).map(([key, v]) => [key, (v as UploadedPhoto).path]),
      )

      const { data: insertedRow, error: insertError } = await supabase
        .from('body_checkins')
        .insert({
          athlete_id: athlete.id,
          date,
          photos,
          weight_kg: weightKg ? parseFloat(weightKg) : null,
          notes: notes.trim() || null,
        })
        .select()
        .single()
      if (insertError || !insertedRow) throw new Error('Speichern fehlgeschlagen')
      insertedId = insertedRow.id

      setPhase('analysing')

      const currentImages: ImageInput[] = Object.entries(uploaded).map(([key, v]) => ({
        base64: (v as UploadedPhoto).base64,
        mediaType: 'image/jpeg',
        label: `Aktuell — ${SLOT_LABEL[key as Perspective]}`,
      }))

      const previousCheckin = await loadPreviousCheckin(athlete.id, date)
      const previousImages = previousCheckin ? await loadPreviousImages(previousCheckin) : []

      const visionRes = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: buildVisionPrompt(athlete, previousImages.length > 0),
          system: KRAFT_COACH_PROMPT,
          images: [...currentImages, ...previousImages],
          max_tokens: 1000,
        }),
      })
      if (visionRes.ok) {
        const visionJson = await visionRes.json() as { text: string }
        await supabase.from('body_checkins').update({ claude_feedback: visionJson.text }).eq('id', insertedId)
        setFeedback(visionJson.text)
      }

      setDone(true)
    } catch {
      setError('Check-in fehlgeschlagen. Bitte versuche es erneut.')
    } finally {
      setPhase('idle')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (done) {
    return (
      <>
        <AppHeader />
        <div className="min-h-screen p-4 max-w-lg mx-auto page-content flex flex-col items-center text-center gap-4 pt-16">
          <div className="w-16 h-16 rounded-full bg-brand-500/20 flex items-center justify-center shrink-0">
            <IconCheck size={28} className="text-brand-400" />
          </div>
          <h1 className="text-xl font-bold text-slate-100">Check-in gespeichert</h1>
          {feedback ? (
            <div className="w-full text-left bg-slate-800 rounded-2xl p-4 mt-2">
              {renderMarkdown(feedback)}
            </div>
          ) : (
            <p className="text-sm text-slate-400">Dein wöchentlicher Check-in wurde erfasst.</p>
          )}
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 transition-colors"
          >
            Zum Dashboard
          </button>
        </div>
      </>
    )
  }

  const hasAnyPhoto = SLOTS.some(s => files[s.key])
  const submitting = phase !== 'idle'

  return (
    <>
      <AppHeader />
      <div className="min-h-screen p-4 max-w-lg mx-auto page-content">
        <h1 className="text-xl font-bold text-slate-100 mb-2">Wöchentlicher Check-in</h1>
        <p className="text-sm text-slate-400 leading-relaxed mb-6">
          Für beste Vergleichbarkeit: gleiche Tageszeit, nüchtern, gleiche Beleuchtung. Alle drei Perspektiven empfohlen, aber einzeln optional.
        </p>

        <div className="grid grid-cols-3 gap-3 mb-6">
          {SLOTS.map(slot => (
            <label key={slot.key} className="flex flex-col items-center gap-2 cursor-pointer">
              <div className="w-full aspect-[3/4] rounded-xl bg-slate-800 border border-dashed border-slate-600 flex items-center justify-center overflow-hidden">
                {previews[slot.key]
                  ? <img src={previews[slot.key]} alt={slot.label} className="w-full h-full object-cover" />
                  : <IconCamera size={22} className="text-slate-500" />}
              </div>
              <span className="text-xs text-slate-400">{files[slot.key] ? 'Ändern' : slot.label}</span>
              <input
                type="file"
                accept="image/*"
                capture="user"
                className="hidden"
                onChange={e => handleFileSelect(slot.key, e.target.files?.[0] ?? null)}
              />
            </label>
          ))}
        </div>

        <div className="mb-4">
          <label className="text-xs text-slate-400 mb-1 block">Gewicht (kg)</label>
          <input
            type="number"
            value={weightKg}
            onChange={e => setWeightKg(e.target.value)}
            placeholder="70"
            className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-slate-500"
          />
        </div>

        <div className="mb-6">
          <label className="text-xs text-slate-400 mb-1 block">Notizen</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Besonderheiten seit dem letzten Check-in…"
            rows={3}
            className="w-full bg-slate-800 text-slate-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none placeholder:text-slate-500"
          />
        </div>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={!hasAnyPhoto || submitting}
          className="w-full py-3 rounded-xl text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {phase === 'uploading' ? 'Lädt Fotos hoch…' : phase === 'analysing' ? 'Analysiert…' : 'Check-in abschließen'}
        </button>
      </div>
    </>
  )
}
