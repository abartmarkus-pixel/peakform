import { supabase } from './supabase'
import { toDateStr } from './dateUtils'

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
