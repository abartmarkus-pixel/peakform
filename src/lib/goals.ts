import { supabase } from './supabase'
import { toDateStr } from './dateUtils'

// Gibt es ein aktives Ziel (egal welche Priorität), dessen Termin noch kommt? Der Renntag
// selbst zählt noch als kommend (gleiche Grenze wie deactivatePastGoals()). Prüft bewusst
// das Datum und nicht nur active — deactivatePastGoals() läuft fire-and-forget beim
// App-Start und kann noch nicht durch sein, wenn die Analyse startet.
export async function hasUpcomingGoal(athleteId: string): Promise<boolean> {
  const { data } = await supabase
    .from('season_goals')
    .select('id')
    .eq('athlete_id', athleteId)
    .eq('active', true)
    .gte('event_date', toDateStr(new Date()))
    .limit(1)
  return (data?.length ?? 0) > 0
}

// Setzt Saisonziele, deren Termin vorbei ist, auf active = false (kein DELETE, analog
// zum manuellen Deaktivieren in Goals.tsx). Der Renntag selbst zählt noch als aktiv —
// erst ab dem Folgetag wird deaktiviert. Silent failure analog zu syncPushSubscription():
// schlägt der Call fehl, versucht es der nächste App-Start erneut.
export async function deactivatePastGoals(athleteId: string): Promise<void> {
  await supabase
    .from('season_goals')
    .update({ active: false })
    .eq('athlete_id', athleteId)
    .eq('active', true)
    .lt('event_date', toDateStr(new Date()))
}
