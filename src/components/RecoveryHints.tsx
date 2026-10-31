import { useEffect, useState } from 'react'
import type { Athlete, OuraDaily, WeeklyPlan } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { syncOuraData } from '../lib/oura'
import { dayLabelForDate, getISOMonday, toDateStr } from '../lib/dateUtils'
import { insertPlanVersion, isIntensiveEndurance, type DayPlan, type PlanJson } from '../lib/weeklyPlan'
import { fetchLatestPlan } from '../lib/planRecommendation'
import { applyCyclingPower, resolveCyclingTargets } from '../lib/cyclingPower'
import { calculateHRZoneBounds, resolveHRProfile } from '../lib/coachContext'
import { fetchRelevantIllness, markSickDays, startIllness, type IllnessPeriod } from '../lib/illness'
import { IconMoon, IconWarning } from '../lib/icons'

// Morgen-Hinweise aus den Oura-Werten der letzten Nacht (Dashboard + WeeklyPlan):
// 1) niedrige Readiness + harte Ausdauereinheit heute → "Heute locker machen" (Z2, gleiche Dauer)
// 2) erhöhte Körpertemperatur → "Krank melden?"
// Nie stille Plan-Änderung — nur auf Knopfdruck, gespeichert INSERT-only wie jede manuelle Änderung.

// Nutzerentscheidung "zurückhaltend": nur bei deutlichen Signalen
const READINESS_LOW = 60
const TEMPERATURE_HIGH = 0.7

function dismissKey(kind: 'recovery' | 'temperature', day: string) {
  return `pf_hint_${kind}_${day}`
}

function isDismissed(kind: 'recovery' | 'temperature', day: string): boolean {
  try { return localStorage.getItem(dismissKey(kind, day)) === '1' } catch { return false }
}

function dismiss(kind: 'recovery' | 'temperature', day: string) {
  try { localStorage.setItem(dismissKey(kind, day), '1') } catch { /* nur Komfort */ }
}

function makeDayEasy(d: DayPlan): DayPlan {
  return {
    ...d,
    intensity: 'Z2 locker',
    description: `Locker statt geplant — Erholung laut Oura niedrig (ursprünglich ${d.intensity ?? 'intensiv'})`,
    main_set: undefined,
    power: undefined, // applyCyclingPower() berechnet Z2-Watt/-Puls neu
    hr: undefined,
  }
}

export function RecoveryHints({ athlete, onChange }: {
  athlete: Athlete
  /** Nach einer Plan-/Krank-Änderung — z.B. damit WeeklyPlan Plan und Krank-Banner neu setzt. */
  onChange?: (plan: WeeklyPlan | null, illness: IllnessPeriod | null) => void
}) {
  const [night, setNight] = useState<OuraDaily | null>(null)
  const [plan, setPlan] = useState<WeeklyPlan | null>(null)
  const [illness, setIllness] = useState<IllnessPeriod | null>(null)
  const [busy, setBusy] = useState(false)
  const [, rerender] = useState(0)

  const today = new Date()
  const todayStr = toDateStr(today)
  const dayLabel = dayLabelForDate(today)
  const monday = getISOMonday(today)

  useEffect(() => {
    if (!athlete.oura_access_token) return
    ;(async () => {
      await syncOuraData(athlete.id) // teilt sich den laufenden Sync vom App-Start
      const [{ data }, latestPlan, ill] = await Promise.all([
        supabase.from('oura_daily').select('*').eq('athlete_id', athlete.id).eq('day', todayStr).maybeSingle(),
        fetchLatestPlan(athlete.id, toDateStr(monday)),
        fetchRelevantIllness(athlete.id),
      ])
      setNight((data as OuraDaily | null) ?? null)
      setPlan(latestPlan)
      setIllness(ill)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athlete.id, athlete.oura_access_token])

  if (!night) return null

  const planJson = plan?.plan_json as unknown as PlanJson | undefined
  const todayPlan = planJson?.days?.[dayLabel]
  const showRecovery = night.readiness_score != null && night.readiness_score < READINESS_LOW
    && !!todayPlan && isIntensiveEndurance(todayPlan) && !isDismissed('recovery', todayStr)
  const showTemperature = night.temperature_deviation != null && night.temperature_deviation >= TEMPERATURE_HIGH
    && !(illness && !illness.end_date) && !isDismissed('temperature', todayStr)

  if (!showRecovery && !showTemperature) return null

  async function handleEasy() {
    if (!plan || !planJson || !todayPlan || busy) return
    setBusy(true)
    try {
      const { effectiveMaxHR, restingHR } = resolveHRProfile(athlete)
      const updated = applyCyclingPower(
        { ...planJson, days: { ...planJson.days, [dayLabel]: makeDayEasy(todayPlan) } },
        resolveCyclingTargets(athlete, calculateHRZoneBounds(effectiveMaxHR, restingHR)),
      )
      const inserted = await insertPlanVersion({
        athleteId: athlete.id,
        weekStart: plan.week_start,
        planJson: updated,
        changeReason: `Erholung niedrig (Oura-Readiness ${night!.readiness_score}) — ${dayLabel} locker statt ${todayPlan.intensity ?? 'intensiv'}`,
        decisionType: 'recovery_low_adjusted',
        decisionSummary: `${dayLabel}: ${todayPlan.type} auf Z2 locker reduziert (Oura-Readiness ${night!.readiness_score})`,
      })
      setPlan(inserted)
      onChange?.(inserted, illness)
    } catch (e) {
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  async function handleSick() {
    if (busy) return
    setBusy(true)
    try {
      const ill = await startIllness(athlete.id, todayStr)
      setIllness(ill)
      let inserted: WeeklyPlan | null = plan
      if (plan && planJson) {
        inserted = await insertPlanVersion({
          athleteId: athlete.id,
          weekStart: plan.week_start,
          planJson: markSickDays(planJson, monday, todayStr),
          changeReason: `Krank gemeldet ab ${todayStr} (Oura: Temperatur +${night!.temperature_deviation!.toFixed(1)} °C)`,
          decisionType: 'illness_reported',
          decisionSummary: `Krank gemeldet ab ${todayStr} nach erhöhter Körpertemperatur laut Oura — Trainingstage ab heute als Ruhetage`,
        })
        setPlan(inserted)
      }
      onChange?.(inserted, ill)
    } catch (e) {
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {showTemperature && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 flex items-start gap-3">
          <IconWarning size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-200 mb-3">
              Deine Körpertemperatur war letzte Nacht erhöht (+{night.temperature_deviation!.toFixed(1)} °C). Fühlst du dich krank?
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handleSick}
                disabled={busy}
                className="text-xs bg-amber-500 hover:bg-amber-600 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                Krank melden
              </button>
              <button
                onClick={() => { dismiss('temperature', todayStr); rerender(n => n + 1) }}
                className="text-xs text-amber-400/70 hover:text-amber-300 px-2 py-1.5 transition-colors"
              >
                Nein, alles gut
              </button>
            </div>
          </div>
        </div>
      )}

      {showRecovery && !showTemperature && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 flex items-start gap-3">
          <IconMoon size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-200 mb-3">
              Deine Erholung ist heute niedrig (Readiness {night.readiness_score}). Geplant ist {todayPlan!.type} {todayPlan!.intensity ?? ''}
              {todayPlan!.duration_min ? ` · ${todayPlan!.duration_min} min` : ''}. Lieber locker (Z2) bei gleicher Dauer?
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handleEasy}
                disabled={busy}
                className="text-xs bg-amber-500 hover:bg-amber-600 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                Heute locker machen
              </button>
              <button
                onClick={() => { dismiss('recovery', todayStr); rerender(n => n + 1) }}
                className="text-xs text-amber-400/70 hover:text-amber-300 px-2 py-1.5 transition-colors"
              >
                Trotzdem wie geplant
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
