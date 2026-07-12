# PeakForm — Produktspezifikation

> **Für Claude Code:** Halte diese Datei nach jeder Session aktuell.
> SPEC.md beschreibt immer den tatsächlich implementierten Stand — nicht was geplant war.
> Committe SPEC.md zusammen mit dem Feature-Code.

> Letzte Aktualisierung: 12. Juli 2026 (Feature: Self-Service Konto-Löschung — neuer rot abgesetzter Button „Konto löschen" ganz unten in `Profile.tsx` mit Bottom-Sheet-Bestätigungsmodal (Zwei-Stufen-Bestätigung); Ablauf: `deauthorizeStrava()` (neu, `src/lib/strava.ts`, ruft `/api/strava-token` mit neuem `grant_type: 'deauthorize'` auf, proxied zu `strava.com/oauth/deauthorize`, fehlertolerant) trennt zuerst die Strava-Verbindung, danach löscht die neue Postgres-Funktion `delete_athlete_account(p_athlete_id UUID)` (SECURITY DEFINER, siehe Kapitel 18) in einer Transaktion `chat_messages`→`coach_decisions`→`weekly_plans`→`activities`→`season_goals`→`athletes`; `p_athlete_id` kommt ausschließlich aus dem geladenen Session-Athleten; schlägt die DB-Löschung fehl, automatischer Rollback + Fehleranzeige im Modal ohne Redirect, schlägt nur die Strava-Trennung fehl, Hinweis auf manuelles Trennen unter strava.com/settings/apps vor dem finalen Logout-Redirect; Anlass: zweiter echter Athlet mit echten personenbezogenen Daten in der App, bisher liefen Löschungen nur manuell direkt in Supabase; verifiziert per Test-Athlet mit Daten in allen 6 Tabellen — SQL bestätigt vollständige Löschung ohne Kollateralschaden an den beiden echten Athleten, siehe Kapitel 9 „Profile.tsx — Konto löschen" und Kapitel 18; davor Bugfix: Echtzeit-Alert-Banner erschien nach echtem App-Neustart erneut, obwohl bereits per "Verwerfen" weggeklickt — das bisherige `sessionStorage`-Gate (`peakform_alert_{weekStart}`) überlebte keinen Prozess-Neustart (v.a. iOS PWA), "Verwerfen" persistierte nichts Dauerhaftes; behoben durch neuen `coach_decisions`-Eintrag `decision_type='realtime_alert_dismissed'` mit `related_plan_id` = aktuelle `weekly_plans.id` beim Klick auf "Verwerfen", Konflikt-Check in `Dashboard.tsx` überspringt Claude-Call komplett, sobald für die geladene Plan-Version bereits ein solcher Eintrag existiert; `sessionStorage`-Gate vollständig entfernt; da der Dismiss an die konkrete Plan-`id` statt an `week_start` gebunden ist, macht jede neue Plan-Version (Plan anpassen/Review/manuelle Änderung) den alten Dismiss automatisch obsolet; verifiziert per SQL-Transaktion (`BEGIN…ROLLBACK`, kein Testdaten-Rückstand) gegen die Produktions-DB, siehe Kapitel 18.3 „Bugfix 12. Juli 2026"; davor Bugfix: doppelte automatische Aktivitäts-Analyse bei gleichzeitigen Syncs — per Live-Test (Dummy-Aktivität mit `claude_analysis = NULL`, zwei parallele Seitenaufrufe) verifiziert, dass React StrictMode's Dev-Doppel-Mount des Dashboard-`useEffect` sowie ein zeitgleicher Sync aus `WeeklyPlan.tsx` dieselbe unanalysierte Aktivität parallel aufgreifen und zwei echte Claude-Calls dafür auslösen konnten; behoben durch neue Spalte `activities.analysis_claimed_at` + `claimActivityForAnalysis(activityId)` (neu, `src/lib/activityAnalysis.ts`) — atomares conditional `UPDATE ... WHERE claude_analysis IS NULL AND (analysis_claimed_at IS NULL OR abgelaufen nach 2 Min)`, das sowohl der Sync-Hintergrundjob in `syncActivitiesToSupabase()` als auch der Fallback `closeOutstandingAnalyses()` vor jedem `analyzeActivity()`-Aufruf durchlaufen; nur ein konkurrierender Aufruf gewinnt den Claim, der Verlierer überspringt die Aktivität; Claim wird nach Erfolg/Fehlschlag zurückgesetzt, ein verwaister Claim (z. B. Tab während der Analyse geschlossen) heilt nach 2 Minuten selbstständig; der manuelle „Neu analysieren"-Button umgeht den Claim bewusst, siehe Kapitel 5 „activities", Kapitel 9 „Auto-Analyse — Race-Fix" und Kapitel 10 „Fallback: `closeOutstandingAnalyses()`"; davor Feature: „Plan generieren"-Button für bereits abgelaufene Wochen entfernt — neue Variable `isPastWeek = monday < getISOMonday(new Date())` in `WeeklyPlan.tsx` (gleiches Vergleichsmuster wie die bestehende Wochenreview-Sichtbarkeit `monday <= getISOMonday(new Date())`, dort unverändert); bei `isPastWeek` entfällt der Button ersatzlos — ohne Plan erscheint stattdessen der neutrale Hinweistext „Für diese Woche wurde kein Plan erstellt", mit Plan gar nichts (der Plan wird oberhalb ja bereits normal angezeigt); aktuelle und zukünftige Wochen zeigen den Button unverändert mit bisheriger Label-Logik („Plan für diese Woche generieren" ohne Plan, „Plan neu generieren" mit Plan); verhindert ausschließlich das rückwirkende Erzeugen NEUER Pläne für vergangene Wochen, siehe Kapitel 10 „Button-Sichtbarkeit — Plan generieren"; davor Refactor: Wochenreview und Plan-Generierung vollständig entkoppelt — `startReview()` erzeugt ab jetzt ausschließlich eine Bewertung der abgelaufenen Woche (`{ review: string }`, `max_tokens` 3000→600), keinen `next_week_plan` mehr; alle Sportarten-/Trainingstage-Constraints und das SELF-CHECK für den Folgeplan wurden aus dem Review-Prompt entfernt — das bleibt exklusiv Sache von `generatePlan()`; `saveReviewData(reviewText)` legt die neue Version jetzt auf `week_start = weekStr` (die **bewertete** Woche W selbst) statt auf der Folgewoche an, `plan_json` wird dabei unverändert vom Vorgänger übernommen (Spalte ist `NOT NULL` — Guard verhindert Review-Speicherung, falls für die Woche noch gar kein Plan existiert); `hasViolation`-Parameter + Amber-Violation-Banner im Review-Bereich entfernt, da ohne Plan-Generierung keine Constraint-Verletzung mehr möglich ist; `WeeklyReviewCard`-Anzeige auf einen einzigen Check (`plan?.review_notes`) vereinfacht — der separate `nextWeekPlan`-Query (`week_start = W+1`) und die bisherige Fall-A/Fall-B-Unterscheidung sind komplett entfallen; Effekt: „Plan generieren" wird nie mehr implizit durch ein Review ausgelöst, nach einem Review zeigt die Folgewoche „Noch kein Plan für diese Woche", bis der Athlet ihn explizit anstößt; Reviews vor diesem Fix bleiben als bekannte, harmlose Alt-Daten-Inkonsistenz auf `week_start = W+1` liegen (kein Migrations-Fallback), siehe Kapitel 10 „Wochenreview" und „Wochenreview-Ergebnis-Karte"; davor Feature: Wochenreview-Ergebnis-Karte + persistenter User-Freitext — neue Spalte `weekly_plans.review_user_input` speichert ab jetzt den rohen, unveränderten Freitext des Athleten aus dem Review-Formular (bisher nur ephemer im React-State, nie persistiert); `saveReviewData()` (`WeeklyPlan.tsx`) schreibt sie zusätzlich zu `review_notes` im selben INSERT; neue aufklappbare Komponente `WeeklyReviewCard` (Titel „Wochenreview" + Chevron, standardmäßig ausgeklappt, lokaler Expand-State ohne Persistenz) zeigt „Deine Notizen:" (falls vorhanden) + „Coach-Bewertung:" in zwei datenbankgetriebenen Fällen: Fall A — der geladene `plan` der angezeigten Woche trägt bereits `review_notes` (Plan entstand aus dem Review der Vorwoche) → Karte erscheint oberhalb des Plan-Inhalts, ergänzt ihn statt ihn zu ersetzen; Fall B — ein zusätzlich geladener `nextWeekPlan` (Query auf `week_start = W+1`, gleiche UTC-Fallback-Logik wie der Haupt-Plan-Query) trägt `review_notes` (Woche W wurde bereits reviewt) → Karte ersetzt in der Wochenreview-Sektion vollständig das bisherige Eingabe-Formular (Aktivitätsliste + Textarea + Button); `saveReviewData()` setzt `nextWeekPlan` direkt nach dem Insert, wodurch Fall B ohne Reload greift; Legacy-Reviews vor diesem Fix (`review_user_input IS NULL`) zeigen nur die Coach-Bewertung, „Deine Notizen"-Bereich bleibt ausgeblendet; ersetzt die bisherige rein ephemere `reviewResult`-Anzeige, die beim Wochenwechsel/Reload verlorenging, siehe Kapitel 5 „weekly_plans" und Kapitel 10 „Wochenreview-Ergebnis-Karte"; davor Feature: Roast-Me-Freischalt-Logik — neue Athleten müssen seit dem Onboarding (`athletes.created_at`) mindestens 3 eigene Aktivitäten synchronisiert haben, bevor „Roast Me" nutzbar wird; historische, beim allerersten Strava-Sync automatisch mitimportierte alte Aktivitäten zählen nicht mit. `checkRoastUnlock(athleteId, createdAt)` (lokal in `ActivityDetail.tsx`) zählt `activities` mit `date >= createdAt`, Ergebnis `{unlocked, remaining}` im neuen State `roastUnlock`, einmalig beim Laden aufgerufen; Button bleibt bei `unlocked: false` sichtbar und klickbar, aber grau (`bg-slate-600 opacity-40 cursor-not-allowed`), Klick zeigt statt Claude-Call einen 2,5s-Toast mit exakter Restanzahl; Bestandsuser mit längst erreichter Schwelle sehen keinerlei Unterschied, siehe Kapitel 9 „ActivityDetail.tsx — Roast Me"; davor Feature: Dynamische Z2-Pace-Kalibrierung aus echten Läufen — `calculateDynamicZ2Pace(runningActivities, hrZoneMin, hrZoneMax)` (neu, `coachContext.ts`) filtert die letzten Laufaktivitäten auf solche mit `avg_hr` innerhalb der Z2-HF-Range (+3/−5 bpm Toleranz) und vorhandenen `distance_m`/`duration_s`, nimmt davon die letzten 8 und berechnet einen distanzgewichteten Pace-Durchschnitt (`totalDurationSec / totalDistanceKm`, nicht den einfachen Mittelwert der Einzel-Paces, damit längere Läufe stärker einfließen); ab mindestens 3 qualifizierenden Läufen liefert sie `{paceSecPerKm, basedOnRuns}`, sonst `null` (Fallback); `calculateHRZones()` wurde dafür refaktoriert — die Z2-Grenzen werden jetzt über die neue Hilfsfunktion `calculateZ2HRRange(maxHR, restingHR?)` (Karvonen-Methode wenn `restingHR` vorhanden, sonst %-Methode) berechnet und sowohl für den Zonen-Text als auch numerisch weiterverwendet, keine doppelte Formel mehr; `calculatePaceReference()` bekommt einen neuen optionalen 3. Parameter `dynamicZ2` — ist er gesetzt, wird die „Z2 Trainingspace"-Zeile aus `dynamicZ2.paceSecPerKm ± 15s` gebaut und mit „(aus deinen letzten N Läufen berechnet, nicht aus 5k-PB geschätzt)" gekennzeichnet, sonst bleibt die bisherige Formel (`best5kSeconds/5 × 1.15–1.30`) als Fallback aktiv; Zielpace und Schwellenpace bleiben in jedem Fall unverändert aus der 5k-Bestzeit berechnet, da sie Zielwerte für ein zukünftiges Event sind, keine Ist-Werte der aktuellen Form; `buildCoachSystemPrompt()` (`coachPrompt.ts`) lädt dafür zusätzlich die letzten 30 Läufe (`Run`/`VirtualRun`/`TrailRun`, neueste zuerst) parallel zu Athlet/A-Event und übergibt das Ergebnis von `calculateDynamicZ2Pace()` an `calculatePaceReference()` — behebt das Problem, dass die rein formelbasierte Z2-Pace die aktuelle Form regelmäßig überschätzte, siehe Kapitel 12 und Kapitel 18 „Coach-System"; davor Feature: Vorgezogene Trainingstage erkennen und verknüpfen — `matchActivityToDay()` erkennt jetzt an **jedem** Tag (nicht mehr nur an Ruhetagen) eine `extraActivity`, deren Sportart nicht zum geplanten `dayPlan.type` passt, unabhängig vom regulären Status (`completed`/`missed`/`pending`); `DayCard` zeigt dafür ein „+1"-Badge + Zeile „Außerdem: {name}"; ein zentrales `dayMatches`-Memo ersetzt die bisher dreifache Matching-Berechnung (Wochen-Kennzahlen, DayCard-Rendering, neue Erkennung); darauf aufbauend erkennt `pickupSuggestion`, ob eine `extraActivity` an Tag A zur noch unerledigten (`pending`) Sportart eines anderen Tages B passt, und zeigt einen dismissable, neutral-blauen Banner „Du hast dein {Sportart} für {Tag} bereits heute/am {Tag} gemacht — als erfüllt markieren?" mit „Verknüpfen"/„Nein danke" (Ablehnung wird pro `stravaId`+Zieltag in `dismissedPickupKey` gemerkt, Reset bei Wochenwechsel); Bestätigung setzt `DayPlan._fulfilledBy = {date, stravaId}` auf Tag B — der Tag-Inhalt selbst bleibt unverändert — und persistiert über denselben `applyManualEdit()`/`saveManualPlanChange()`-Weg wie Swap/Ruhetag (INSERT-only, `change_reason` z. B. „Krafttraining von So auf Sa vorgezogen", `coach_decisions`-Eintrag `decision_type='manual_plan_edit'` automatisch); `matchActivityToDay()` behandelt einen Tag mit gesetztem `_fulfilledBy` als `completed` und löst `activity` über die verknüpfte `stravaId` auf statt über den Kalendertag — `DayCard` zeigt zusätzlich „Vorgezogen am {Wochentag, Datum}", Tap navigiert zur echten Aktivität; Long-Press-Kontextmenü bekommt bei gesetztem `_fulfilledBy` den Eintrag „Verknüpfung aufheben" (entfernt das Feld wieder); Wochen-Kennzahlen und Wochenreview zählen den Tag automatisch korrekt als absolviert, da beide auf demselben `dayMatches`-Status bzw. der rohen Aktivitätsliste basieren, keine separate kalenderbasierte Zählung — siehe Kapitel 10 „Manuelles Vorziehen erkannter Aktivitäten"; davor Drei Korrekturen am manuellen Verschieben von Trainingstagen in `WeeklyPlan.tsx`: (1) Bugfix Persistenz — `commitManualChange()` las den zu speichernden Plan bisher aus dem `manualPlanJson`-State statt aus einem Parameter; da der No-Konflikt-Pfad `commitManualChange()` synchron im selben Tick wie `setManualPlanJson()` aufrief, griff dort eine Stale Closure — die allererste manuelle Änderung nach Seitenaufruf wurde dadurch gar nicht gespeichert (stiller Totalverlust), jede weitere speicherte die vorherige statt der aktuellen Änderung; behoben durch einheitliche Signatur `commitManualChange(updatedPlan, changeReason, hasViolation)`, die den Plan in jedem Aufrufpfad explizit als Parameter bekommt; (2) der „•••"-Button wurde wieder entfernt, Kontextmenü öffnet wieder per 500ms-Long-Press auf die Karte (funktioniert jetzt konfliktfrei, da nur der dedizierte Drag-Griff auf Pointer-Events für den Sortier-Drag reagiert), Menü auf zwei Einträge reduziert (Ruhetag-Eintrag + „Verschieben nach...", „Details anzeigen" entfernt); (3) „Als Ruhetag markieren" verwirft den ursprünglichen Taginhalt nicht mehr, sondern speichert ihn eingebettet in `_restoreFrom` — das Menü zeigt bei manuell erzeugten Ruhetagen stattdessen „Aktivität wiederherstellen", bei echten (vom Coach geplanten) Ruhetagen weiterhin nichts; Details siehe Kapitel 10 „Manuelles Verschieben von Trainingstagen"; davor Bugfix: PointerSensor-`distance`-Schwelle (8px) beim Drag-and-Drop führte auf Mobile dazu, dass normales vertikales Scrollen fälschlich als Drag-Start erkannt wurde — betraf sowohl die Wochenplan-Tage (`WeeklyPlan.tsx`) als auch das Muskelgruppen-Ranking (`Profile.tsx`); behoben durch zwei Maßnahmen: (1) `activationConstraint` von `{distance: 8}` auf `{delay: 200, tolerance: 8}` umgestellt (200ms bewusstes Halten statt sofortiger 8px-Bewegung startet den Drag) und (2) expliziter Drag-Griff (`IconGrip`) eingeführt — `attributes`/`listeners` aus `useSortable()` hängen jetzt nur noch am Griff-Button, nicht mehr an der ganzen Karte/Zeile, wodurch der Rest der Fläche uneingeschränkt scrollbar bleibt (kein `touch-none` außerhalb des Griffs); zusätzlich wurde das 500ms-Long-Press-Kontextmenü in `WeeklyPlan.tsx` durch einen expliziten „•••"-Button (`IconMore`, neuer Export in `icons.ts`) ersetzt, der das bestehende Bottom-Sheet per Tap statt Halten öffnet — vermeidet Kollision mit der neuen delay-Aktivierung, siehe Kapitel 10 „Manuelles Verschieben von Trainingstagen" und Kapitel 9 „Profile.tsx" (Teil B — Körperziele); davor Feature: Manuelles Verschieben von Trainingstagen im laufenden Wochenplan — Drag-and-Drop-Tausch zweier Tage via `@dnd-kit` (`swapDays()`, `SortableDayCard` als Wrapper um `DayCard`, gleiches Sensor-/Drag-Optik-Setup wie beim Ästhetik-Ranking in Profile.tsx), Long-Press-Kontextmenü (500ms, 8px Bewegungstoleranz — eigene Pointer-Handler koexistieren mit dem dnd-kit-Sensor) mit den drei Optionen „Als Ruhetag markieren"/„Verschieben nach..."/„Details anzeigen" als Bottom-Sheet (gleicher Stil wie das Mid-Week-Feedback-Modal), client-seitige Konflikt-Prüfung `checkPlanConflicts()` (reine Funktion, kein Claude-Call — nutzt dieselbe „intensiv"-Definition wie der `generatePlan()`-Prompt: Z3+-Ausdauer und Krafttraining zählen beide als intensiv) mit nicht-blockierendem Amber-Banner („Abbrechen"/„Trotzdem speichern") bei Konflikt bzw. direktem Speichern + Toast bei keinem Konflikt, Persistierung über `saveManualPlanChange()` mit derselben INSERT-only-Versionierung wie `savePlanJson()`/`saveReviewData()` inkl. neuem `coach_decisions`-Eintrag `decision_type='manual_plan_edit'` — siehe Kapitel 10 „Manuelles Verschieben von Trainingstagen"; davor Bugfix: iOS-Safari zoomte beim Fokussieren von Eingabefeldern automatisch in die Seite hinein, weil Safari das bei jeder Schriftgröße unter 16px auslöst — betraf **alle** `<input>`/`<textarea>`/`<select>`-Elemente der App, da sie durchgängig `text-sm` (14px) statt `text-base` (16px) nutzten; behoben in `ActivityDetail.tsx` (Mid-Week-Feedback-Textarea, siehe Kapitel 9 „ActivityDetail.tsx — Mid-Week-Feedback"), `Profile.tsx`, `Goals.tsx`, `Onboarding.tsx`, `Chat.tsx` und `WeeklyPlan.tsx` (Wochenreview-Feedback) — überall `text-sm` durch `text-base` ersetzt, Layout/Padding/Design sonst unverändert; davor Feature: Pagination „Mehr laden" für die Dashboard-Aktivitätsliste — `fetchRecentActivities()` (`src/lib/strava.ts`) um `page`-Parameter erweitert, paginiert gegen die Strava API statt gegen Supabase (Supabase bleibt reiner Write-Cache), siehe Kapitel 9 „Dashboard.tsx — Pagination"; davor Bugfix: Echtzeit-Alert im Dashboard nannte Aktivitätsdatum mit falschem/widersprüchlichem Wochentag — Konflikt-Check-Prompt nutzte rohes `plan_json` (nur Mo-So-Kürzel) statt über `planJsonWithDates()` (jetzt aus `coachContext.ts` exportiert) mit Kalenderdatum angereichert; siehe Kapitel 18.3 „Bugfix 4. Juli 2026"; davor Feature: Mid-Week-Feedback von WeeklyPlan.tsx nach ActivityDetail.tsx verschoben, dort nebeneinander mit „Roast Me" (`grid grid-cols-2 gap-3`, je 50% Breite) — Ladelogik via `.maybeSingle()` auf `coach_decisions` statt Map, siehe Kapitel 9 „ActivityDetail.tsx — Mid-Week-Feedback" und Kapitel 10 „Mid-Week-Feedback — verschoben nach ActivityDetail.tsx"; Dashboard-Aktivitätskarten zeigen dezenten `IconCommentFilled`-Indikator via Batch-Query (Join über `activities.strava_id`, da `coach_decisions.related_activity_id` auf die Supabase-UUID zeigt), siehe Kapitel 9 „Dashboard.tsx — Feedback-Indikator auf Aktivitätskarten"; `buildRoastPrompt()` (`src/lib/funModePrompts.ts`) um optionalen `userFeedback`-Parameter erweitert — Roast Me nutzt vorhandenes Mid-Week-Feedback schamlos als zusätzliches Roast-Material, bleibt aber vollständig ephemer (kein Zurückschreiben nach `coach_decisions`), siehe Kapitel 9 „ActivityDetail.tsx — Roast Me"; davor Feature: Datumszeile in ActivityDetail.tsx um lokale Startuhrzeit ergänzt — `toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'})` + " Uhr" hinter dem Datum, z. B. „Donnerstag, 2. Juli 2026 · 06:05 Uhr", siehe Kapitel 9 „ActivityDetail.tsx — Datumszeile"; davor Bugfix: Roast-Me-Ergebnis — `max_tokens` von 300 auf 500 erhöht (Text endete teils mitten im Wort), Auto-Scroll zur Ergebnis-Card via `roastResultRef` + `scrollIntoView({behavior:'smooth', block:'start'})` nach erfolgreichem Claude-Call, siehe Kapitel 9 „ActivityDetail.tsx — Roast Me"; davor Vereinfachung: „Spaß-Analyse" (3 Modi) zu „Roast Me" (1 Modus) reduziert — nur noch `buildRoastPrompt({name, sport})` statt `buildFunModePrompt(mode, ...)`, ein einzelner Button „🔥 Roast Me 🔥" (Flammen-Icons, orange→rot-Gradient) statt 3-Button-Reihe, Ergebnis-Card im Flammen-Look statt fuchsia, Ton bitterböser/South-Park-artig statt nur frech, `IconSarcastic`/`IconSexy` entfernt, siehe Kapitel 9 „ActivityDetail.tsx — Roast Me"; davor Verbesserung: Sexy-Modus in der Spaß-Analyse (`src/lib/funModePrompts.ts`) 1-2 Stufen frecher — forschere, unverblümtere Anspielungen „unter der Gürtellinie" mit direkteren Formulierungen ("tief reingehen", "aufs Tempo drücken", "es noch mal steigern"), Ton bewusst selbstsicher/schlagfertig statt zurückhaltend; Grenze bleibt unverändert hart: reines Wortspiel über Trainingsdaten, keine explizite Beschreibung sexueller Handlungen, kein Kommentar zu Körper/Aussehen; davor Verbesserung: Spaß-Analyse sportart-spezifisch geschärft — alle 3 Modi erzwingen konkrete Zahlen (Pace/Tempo/HF beim Laufen, Watt/Trittfrequenz/HF beim Rad, Gewicht/Wiederholungen/Muskelgruppen bei Kraft) über `sportVocabHint()`, `ActivityDetail.tsx` leitet `sport` aus `activity.type` ab und füttert `buildFunStatsText()` mit sportart-spezifischen Rohdaten statt generischem Block; davor Feature: Spaß-Analyse in ActivityDetail.tsx — optionale, komplett vom Coach-Gedächtnis isolierte KI-Kommentare in 3 Modi (Sarkastisch/Roast/Sexy), erscheint als Button-Reihe unterhalb der ernsten KI-Analyse, rein ephemer im React-State, siehe Kapitel 9 „ActivityDetail.tsx — Spaß-Analyse"; davor UI-Anpassung: Wochen-Kennzahlen-Leiste im Wochenplan — „X / Y Einheiten"-Zeile entfernt, nur noch eine Zeile mit Lauf-/Rad-km + Kraft-Gesamtgewicht, Icons/Text vergrößert (`size={20}`, `text-base`), siehe Kapitel 10 „Wochen-Kennzahlen-Leiste"; davor Feature: Wochen-Kennzahlen-Leiste im Wochenplan eingeführt — Lauf-/Rad-km + Kraft-Gesamtgewicht zwischen Phasen-Banner und DayCards, ausgeblendet bei Wochen ohne jegliche Aktivität; davor Bugfix: Sportart-Icon in der Dashboard-Aktivitätsliste wurde bei langen Aktivitätsnamen durch fehlendes `flex-shrink-0` vom Flexbox-Layout mitgeschrumpft — siehe Kapitel 9 „Dashboard.tsx"; davor Feature: Automatische Aktivitäts-Analyse nach Strava-Sync — kein manueller Klick auf „Analysieren" mehr nötig, Button heißt jetzt „Neu analysieren", Analyse-Logik in `src/lib/activityAnalysis.ts` extrahiert, siehe Kapitel 9 „Auto-Analyse" und Kapitel 10 „Fallback: `closeOutstandingAnalyses()`"; davor Bugfix: Datumsfehler in Coach-Analysen — falsches Aktivitätsdatum bei Mid-Week-Feedback, fehlende Kalenderdaten im Wochenplan-Kontext, UTC-Slice statt Lokalzeit-Formatierung, siehe Kapitel 11 „Bugfix 2. Juli 2026")

---

## 1. Produkt-Überblick

PeakForm ist eine PWA (Progressive Web App) die als KI-Trainingscoach fungiert. Sie verbindet Strava-Aktivitätsdaten (Ausdauer + Krafttraining via Hevy-Description) mit Claude als Coach-Intelligenz und Supabase als persistentem Datenspeicher.

**Kernversprechen:** Der Coach kennt den Athleten, erinnert sich an Plan-History und Reviews, plant vorausschauend und gibt konkrete, datenbasierte Analyse-Antworten.

**Zielgruppe:** Mehrere vertrauenswürdige Nutzer (aktuell Markus + 1 zweiter Athlet, jeweils eigenes Gerät/eigener Strava-Account). Architektur trennt Athleten über `athlete_id`-Pattern auf Anwendungsebene (siehe Kapitel 18), aber es gibt weder Supabase Auth noch öffentliches Onboarding — Zugang bleibt manuell/eingeladen.

**Live URL:** peakform-wheat.vercel.app  
**Repository:** github.com/abartmarkus-pixel/peakform (privat)  
**Branch:** `main` → Auto-Deploy auf Vercel  

---

## 2. Tech-Stack

| Layer | Technologie | Version |
|---|---|---|
| Frontend | React | 18.3 |
| Build | Vite | 5.3 |
| Styling | Tailwind CSS | 3.4 |
| Routing | React Router v6 | 6.24 |
| Icons | react-icons (Font Awesome 6 Free) | 5.6 |
| Charts | Recharts | 2.12 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities | 6.3 / 10.0 / 3.2 |
| Sprache | TypeScript | 5.2 |
| Backend/DB | Supabase (PostgreSQL) | @supabase/supabase-js 2.43 |
| Hosting | Vercel (Fluid Compute) | — |
| PWA | vite-plugin-pwa | 0.20 |
| KI | Claude Sonnet (claude-sonnet-4-6) via `/api/analyse` | — |
| Ausdauer/Kraft | Strava API v3 (scope: `read,activity:read_all`) | — |

**Kein Hevy API** — Krafttraining-Daten kommen aus der Strava-`description`-Spalte (Hevy schreibt Workouts automatisch in Strava-Beschreibungen).

---

## 3. Projektstruktur

```
peakform/
├── api/
│   ├── analyse.ts          # Vercel Serverless Function — Claude API Proxy
│   │                         Params: { prompt, max_tokens?, system?, images? }
│   │                         Limits: 80.000 Zeichen, max_tokens Cap 4.096, max. 10 Bilder, max. 2M Base64-Zeichen/Bild
│   └── strava-token.ts     # Vercel Serverless Function — Strava OAuth Token Exchange/Refresh
│                             STRAVA_CLIENT_SECRET ausschließlich server-seitig
├── public/
│   ├── peakform-logo.png        # Schriftzug Header (1x, max 320×80)
│   ├── peakform-logo@2x.png     # Schriftzug Header (2x Retina)
│   ├── favicon-16.png           # Favicon 16×16
│   ├── favicon-32.png           # Favicon 32×32
│   ├── apple-touch-icon.png     # iOS Home-Screen Icon 180×180
│   ├── icon-192.png             # PWA Icon 192×192
│   ├── icon-512.png             # PWA Icon 512×512 (auch maskable)
│   ├── splash.png               # PWA Splash 1024×1024
│   └── splash-bg.jpg            # Home.tsx Hintergrundbild, max 1200px, JPEG 80%
├── src/
│   ├── App.tsx             # Router (10 Routen) + Layout-Wrapper mit BottomNav
│   │                       # Splash-Screen: NUR wenn eingeloggt (athlete_strava_id in localStorage/sessionStorage)
│   │                       # Dauer: 2000ms + 400ms Fade-out; bg-slate-900; splash.png zentriert 80% Breite, CSS peakform-pulse; kein Logo
│   │                       # Session-Guard: nach Session-Herstellung wird athletes.onboarding_completed geprüft
│   │                       # → false: Redirect zu /onboarding (unabhängig von der ursprünglich angeforderten Route)
│   ├── components/
│   │   ├── AppHeader.tsx   # Fixierter Header (h-14); Props: rightAction?: React.ReactNode
│   │                       # Logo links (Link zu /dashboard, cursor-pointer), rightAction rechts (justify-between); jede Page rendert ihn selbst
│   │   └── BottomNav.tsx   # Fix-positionierte 5-Tab Navigation (Home|Plan|Coach|Ziele|Profil)
│   │                         Sichtbar auf allen Seiten außer /, /auth/callback und /onboarding
│   ├── pages/
│   │   ├── Home.tsx           # bg-slate-900 + Logo zentriert + Strava-Button; Auto-Redirect zu /dashboard (kein splash-bg.jpg)
│   │   ├── AuthCallback.tsx   # OAuth-Code → /api/strava-token → Supabase upsert → localStorage
│   │   ├── Onboarding.tsx     # Verpflichtender 6-Schritte-Wizard, einmalig nach erstem Login (siehe Kapitel 9)
│   │   ├── Dashboard.tsx      # letzte 10 Aktivitäten + Typ-Filter + "Mehr laden" (Strava-Pagination); AppHeader mit Logout-Icon rechts
│   │   ├── ActivityDetail.tsx # Stats-Grid + Charts + Rundentabelle + Hevy-Übungen + Claude-Analyse
│   │   ├── Profile.tsx        # Athleten-Profil mit 800ms Auto-Save
│   │   ├── Goals.tsx          # Saison-Ziele A/B/C + Countdown + Add/Edit-Modal; AppHeader mit "+" rechts
│   │   ├── WeeklyPlan.tsx     # Wochenplan-Generator + Constraint-Validierung + Review
│   │   │                      # Wochen-Navigation: Prev | Datum (center) | Next (right) — keine Versionsnummer
│   │   └── Chat.tsx           # Globaler Coach-Chat mit Supabase-Persistenz
│   │                          # AppHeader mit "Neu"-Button rechts; Container: mt-[72px], h=calc(100vh-136px)
│   └── lib/
│       ├── supabase.ts        # Supabase Client + TypeScript-Types
│       ├── strava.ts          # OAuth URL, Token Exchange/Refresh via /api/strava-token, Activities, Streams, Laps
│       │                        getValidAccessToken(): setzt set_athlete_context RPC (RLS-Vorbereitung)
│       │                        syncActivitiesToSupabase(): Upsert + fire-and-forget Auto-Analyse unanalysierter Aktivitäten (siehe Kapitel 9 „Auto-Analyse")
│       ├── activityAnalysis.ts # analyzeActivity(activity, athleteId): Promise<{success, error?}> — vollständige Claude-Analyse
│       │                        (Specialist-Routing, Streams/Laps/Description cache-first nachladen, Prompt, Speichern, Recovery-Extraktion)
│       │                        triggerRecoveryExtraction() + Chart/Stats/Hevy-Helper (auch von ActivityDetail.tsx für Anzeige importiert)
│       │                        Einzige Implementierung — genutzt vom „Neu analysieren"-Button, vom Sync-Hintergrundjob und vom Plan/Review-Fallback
│       │                        claimActivityForAnalysis(activityId): Promise<boolean> — atomarer Lease-Claim (analysis_claimed_at) gegen doppelte automatische Analyse bei parallelen Syncs (siehe Kapitel 9 „Auto-Analyse — Race-Fix")
│       ├── features.ts        # FeatureFlags Interface, DEFAULT_FEATURES, useFeatures(athlete)
│       ├── icons.ts           # Zentrale Icon-Exports (FA6 via react-icons/fa6) + SPORT_DISPLAY Konstante
│       │                        SPORT_DISPLAY: { cycling, running, strength, rest, other } → { color, label }
│       ├── dateUtils.ts       # ISO 8601 Datums-Helpers (Woche beginnt Montag, Sonntag ist letzter Tag)
│       │                        getISOMonday(date): Date — Montag der Woche in Lokalzeit
│       │                        getISOSunday(monday): Date — Sonntag 23:59:59.999 in Lokalzeit
│       │                        formatWeekRange(monday): string — z. B. "29.6. – 5.7.2026"
│       │                        toLocalDateStr(date): string — "TT.MM.JJJJ" in Lokalzeit (nicht ISO-String-Slice)
│       │                        toLocalWeekdayDateStr(date): string — z. B. "Di 30.6.2026"
│       ├── coachContext.ts    # buildCoachContext(athleteId, threadId?, activeSport?) — 7 Abschnitte, alle parallel
│       │                        Datums-sichere Formatierung überall via toLocalDateStr()/toLocalWeekdayDateStr()
│       │                        (nie date.slice(0,10) auf rohem UTC-ISO-String), siehe Kapitel 11
│       │                        buildSpecialistContext(athleteId, sport) — sportart-spezifische Historien
│       ├── coachPrompt.ts     # buildCoachSystemPrompt(athleteId, activeSport?): Promise<string> (Hauptcoach, dynamisch aus DB)
│       │                        LAUF_COACH_PROMPT | RAD_COACH_PROMPT | KRAFT_COACH_PROMPT (Spezialcoaches, statisch)
│       ├── funModePrompts.ts  # buildRoastPrompt({name, sport}): string — Prompt für „Roast Me"
│       │                        SportFocus = 'running'|'cycling'|'strength'|null
│       │                        sportVocabHint(sport): sportart-spezifischer Vokabel-Zwang (Pace/HF für Lauf,
│       │                        Watt/Trittfrequenz/HF für Rad, Gewicht/Wdh/Muskelgruppen für Kraft) — mindestens
│       │                        2 konkrete Werte müssen wörtlich in der Antwort vorkommen
│       │                        Ton: bitterböse/South-Park-artig, keine Zurückhaltung — Grenze bleibt hart:
│       │                        nur Trainingsdaten, kein Kommentar zu Körper/Aussehen/Charakter der Person
│       │                        komplett unabhängig von coachPrompt.ts/coachContext.ts — keine gemeinsame
│       │                        Logik, kein DB-Zugriff
│       └── markdown.tsx       # renderMarkdown(text): React.ReactNode[] — geteilter Markdown-Lite-Renderer
│                                (h1-h3, Bullets, Blockquotes, **fett**, HR; genutzt von ActivityDetail)
├── vite.config.ts          # PWA-Config + /api/analyse + /api/strava-token Middleware für lokales Dev
├── vercel.json             # SPA Rewrites + SW Cache-Header
└── .env                    # Credentials (nicht committen)
```

---

## 4. Authentifizierung & Session

**Kein Supabase Auth.** Die App nutzt Strava OAuth 2.0 als einzigen Login-Mechanismus.

**Login-Flow:**
1. User klickt "Mit Strava verbinden" → `Home.tsx` ruft `generateOAuthState()` auf (erzeugt `crypto.randomUUID()`, speichert sie in `sessionStorage.oauth_state`) und baut die Auth-URL via `getStravaAuthUrl(state)` (scope: `read,activity:read_all`, inkl. `&state=...`)
2. Strava redirectet zu `/auth/callback?code=...&state=...`
3. `AuthCallback.tsx` prüft **vor** dem Token-Exchange: `state` aus der Callback-URL muss mit `sessionStorage.oauth_state` übereinstimmen. Bei Mismatch/Fehlen → Redirect zu `/` mit `navigate('/', { state: { error: '...' } })`, kein Token-Exchange (CSRF-Schutz)
4. Bei gültigem State: `sessionStorage.removeItem('oauth_state')`, dann `/api/strava-token` (POST, server-side)
5. Server tauscht Code gegen Token (`STRAVA_CLIENT_SECRET` bleibt server-seitig)
6. `athletes` Upsert in Supabase via `strava_athlete_id` als Konflikt-Key
7. `localStorage.setItem('athlete_strava_id', stravaId)` + `sessionStorage.setItem(...)` + `document.cookie = 'pf_athlete_id=' + stravaId + '; max-age=31536000; path=/; SameSite=Lax'` — Basis für alle weiteren Seiten

**Home.tsx Fehleranzeige:** Falls über `navigate('/', { state: { error } })` ein Fehler übergeben wurde (z.B. OAuth state mismatch), zeigt Home.tsx eine rote Fehlermeldung über dem Strava-Button (`location.state.error`).

**Session-Wiederherstellung beim App-Start** (`App.tsx → Layout`):
1. Öffentliche Pfade (`/`, `/auth/callback`): keine Prüfung nötig
2. `localStorage` oder `sessionStorage` enthält `athlete_strava_id`: Session gültig, `localStorage` wird bei Bedarf nachgefüllt
3. Beides leer → `restoreSessionFromSupabase()`: identifiziert den Athleten über das `pf_athlete_id`-Cookie, refresht Token falls abgelaufen, schreibt `athlete_strava_id` zurück in `localStorage` + `sessionStorage`
4. Kein Cookie, kein passender Athleten-Eintrag oder kein `refresh_token` → Redirect zu `/` (echter Strava-Login nötig)
5. Session gültig (egal ob aus Storage oder wiederhergestellt) → `athletes.onboarding_completed` wird per Query geladen; bei `false` (und aktuelle Route ≠ `/onboarding`) → `navigate('/onboarding', { replace: true })`, unabhängig von der ursprünglich angeforderten Route

Splash-Screen: erscheint **nur wenn eingeloggt** (`athlete_strava_id` in localStorage oder sessionStorage beim App-Start). Dauer: 2000ms sichtbar + 400ms Fade-out. Design: `bg-slate-900` + `splash.png` zentriert (80% Breite, max-w-sm), sanft pulsierend via CSS `peakform-pulse` (scale 1→1.05, opacity 1→0.85, 1.5s). Kein PeakForm Logo. Kein Overlay, kein Dots-Indicator. Auf PUBLIC_PATHS (/ und /auth/callback) kein Splash. Nicht eingeloggt auf geschützter Route → Session-Check läuft still, kein Splash.

**`restoreSessionFromSupabase()`** (in `src/lib/strava.ts`):
- Liest `pf_athlete_id` aus `document.cookie`; ohne Cookie → `return false`
- `SELECT id, strava_athlete_id, strava_access_token, strava_refresh_token, expires_at FROM athletes WHERE strava_athlete_id = <cookie-wert>`
- Falls Eintrag mit `refresh_token`: `getValidAccessToken()` aufrufen → `localStorage` + `sessionStorage` setzen → `return true`
- Sonst: `return false`
- Ersetzt das frühere `LIMIT 1`-Pattern: bei mehreren Athleten-Einträgen bekommt jeder Browser (mit eigenem Cookie) den korrekten Account statt eines zufälligen

**Logout:** `localStorage.clear()` + `sessionStorage.clear()` + Cookie löschen (`document.cookie = 'pf_athlete_id=; max-age=0; path=/'`) → Redirect zu `/`

**Token-Refresh:** Automatisch in `getValidAccessToken()` — 60s Buffer vor Ablauf, neuer Token via `/api/strava-token` (grant_type: `refresh_token`), Update in Supabase.

**athletes.id** ist eine eigene UUID (kein `auth.uid()`). RLS ist aktiv, aber auf offener Policy (kein User-Auth-Binding via auth.uid()).

---

## 5. Datenbankschema (Supabase PostgreSQL)

### athletes
```sql
id                    UUID PRIMARY KEY (eigene UUID, nicht auth.uid())
strava_athlete_id     BIGINT UNIQUE        -- Login-Identifier, in localStorage
strava_access_token   TEXT
strava_refresh_token  TEXT
expires_at            TIMESTAMPTZ
name                  TEXT
ftp_watts             INTEGER
max_hr                INTEGER
weight_kg             DECIMAL
training_days_per_week INTEGER             -- Gesamtzahl Trainingstage/Woche (1–7)
sport_types           JSONB                -- Format: [{type, days}]
coach_persona         JSONB                -- Format: {style, focus}
body_goals            TEXT[]               -- Mehrfachauswahl-Array
equipment             JSONB                -- Format: {dumbbells:{active,max_kg?},bands:{active},bodyweight:{active},pullup_bar:{active},gym:{active}}
aesthetic_goals       JSONB                -- Format: {priorities:string[],notes:string}
season_phase_override TEXT DEFAULT NULL   -- 'readaptation'|'base'|'race'|'taper'|NULL (NULL = automatisch aus event_date)
best_5k_seconds       INTEGER DEFAULT NULL -- 5k-Bestzeit in Sekunden; Basis für Pace-Berechnung
ftp_updated_at        TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten FTP-Eingabe
max_hr_updated_at     TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten Max HF-Eingabe
weight_updated_at     TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten Gewicht-Eingabe
best_5k_updated_at    TIMESTAMPTZ DEFAULT NULL -- Zeitpunkt der letzten 5k-Bestzeit-Eingabe
-- Persönliche Daten
gender                TEXT CHECK (gender IN ('male', 'female', 'diverse')) DEFAULT NULL
birth_year            INTEGER CHECK (birth_year BETWEEN 1940 AND 2010) DEFAULT NULL
resting_hr            INTEGER CHECK (resting_hr BETWEEN 30 AND 100) DEFAULT NULL
-- Feature-Flags
features              JSONB DEFAULT '{"cycling":true,"running":true,"strength":true,"weekly_plan":true,"coach_chat":true,"goals":true}'
-- Onboarding
onboarding_completed  BOOLEAN DEFAULT false -- true = Wizard durchlaufen; false = Redirect zu /onboarding bei jedem Login
created_at            TIMESTAMPTZ
```

**sport_types JSONB Format (tatsächlich):**
```json
[
  { "type": "cycling",  "days": 2 },
  { "type": "running",  "days": 2 },
  { "type": "strength", "days": 1 }
]
```
- `type`: `"cycling"` | `"running"` | `"strength"`
- `days`: exakte Anzahl Einheiten pro Woche (Integer ≥ 1)
- Eintrag mit `days: 0` wird entfernt (nicht gespeichert)

**coach_persona JSONB Format:**
```json
{ "style": "analytisch", "focus": "Ich neige zu Übertraining..." }
```
- `style`: `"motivierend"` | `"analytisch"` | `"direkt"` | `"empathisch"` (oder leer)
- `focus`: Freitext-Anweisung an den Coach

**body_goals mögliche Werte:** `"Event"` | `"Muskelaufbau"` | `"Gewicht reduzieren"`

**Migration (1. Juli 2026):** Der frühere Wert `"Nackt gut ausschauen"` wurde entfernt. Beim Profil-Load in `Profile.tsx` wird ein noch in der DB vorhandener Legacy-Wert automatisch migriert: Eintrag wird aus dem Array entfernt; war er der einzige Eintrag, wird `"Muskelaufbau"` als Ersatz hinzugefügt (sonst bleibt das Array wie es ist). Die Migration läuft rein im Code (kein DB-Skript), das Ergebnis wird beim nächsten Auto-Save persistiert.

---

### activities
```sql
id              UUID PRIMARY KEY
athlete_id      UUID → athletes.id
strava_id       BIGINT UNIQUE
name            TEXT
type            TEXT               -- 'Ride','VirtualRide','Run','VirtualRun','WeightTraining',…
date            TIMESTAMPTZ
distance_m      NUMERIC
duration_s      INTEGER
avg_hr          NUMERIC
max_hr          NUMERIC
np_watts        NUMERIC            -- Normalized Power (nur Rad)
tss             NUMERIC            -- Training Stress Score (selten befüllt)
streams_json         JSONB              -- Cache: time,heartrate,altitude,velocity_smooth,watts,cadence
laps_json            JSONB DEFAULT NULL -- Cache: Strava Laps Array (StravaLap[]), beim ersten Öffnen gecacht
splits_metric_json   JSONB DEFAULT NULL -- Cache: Strava splits_metric (StravaSplitMetric[]), nur Runs
description          TEXT               -- Cache: Strava-Description (für WeightTraining / Hevy)
claude_analysis      TEXT               -- gespeichert nach erstem Analyse-Run
analysis_claimed_at  TIMESTAMPTZ DEFAULT NULL -- Lease für automatische Analyse (siehe `claimActivityForAnalysis()`, Kapitel 9 „Auto-Analyse")
created_at      TIMESTAMPTZ
```

**Cache-first Logik:**
- `streams_json`: beim ersten Öffnen von ActivityDetail von Strava geholt + in Supabase gespeichert; danach immer aus Supabase
- `laps_json`: beim ersten Öffnen parallel zu `streams_json` von Strava Laps-Endpoint geholt + gespeichert; danach immer aus Supabase
- `splits_metric_json`: bei Lauf-Aktivitäten beim ersten Öffnen via `GET /activities/{id}` → `splits_metric` Feld geholt + gespeichert; danach immer aus Supabase
- `description`: bei WeightTraining beim ersten Öffnen von Strava Detail-Endpoint geholt + gespeichert; danach immer aus Supabase

---

### season_goals
```sql
id          UUID PRIMARY KEY
athlete_id  UUID → athletes.id
event_name  TEXT
event_date  DATE
distance_km DECIMAL
elevation_m INTEGER
priority    ENUM('A','B','C')
sport_type  TEXT
notes       TEXT
active      BOOLEAN DEFAULT true
created_at  TIMESTAMPTZ
```
- Ziele werden nie gelöscht — `active = false` statt DELETE
- `priority`: A = Hauptziel, B = wichtig, C = Nebenziel

---

### weekly_plans
```sql
id                       UUID PRIMARY KEY
athlete_id               UUID → athletes.id
week_start               DATE              -- immer Montag (YYYY-MM-DD)
version                  INTEGER           -- startet bei 1, inkrementiert bei Neugenerierung
plan_json                JSONB             -- PlanJson: {summary, days: {Mo…So: DayPlan}}
review_notes             TEXT              -- Review-Text dieser Woche selbst (aus startReview()); Reviews vor 6. Juli 2026 liegen als Legacy-Daten stattdessen auf week_start = W+1
review_user_input        TEXT              -- Roher Freitext-Input des Athleten aus dem Review-Formular (unverändert, ohne Claude-Verarbeitung); NULL bei vor 6. Juli 2026 abgeschlossenen Reviews (Legacy)
change_reason            TEXT
plan_constraint_violation BOOLEAN DEFAULT false
created_at               TIMESTAMPTZ
```

**plan_json Format:**
```json
{
  "summary": "Einzeiliger Wochen-Überblick (max 120 Zeichen)",
  "days": {
    "Mo": { "type": "Laufen", "duration_min": 45, "distance_km": null, "intensity": "Z2", "description": "Ruhiger Z2-Lauf" },
    "Di": { "type": "Kraft",  "duration_min": 60, "distance_km": null, "intensity": null, "description": "Workout I" },
    "Mi": { "type": "Ruhetag","duration_min": 0,  "distance_km": null, "intensity": null, "description": "Regeneration" }
  }
}
```

**Lauf-Regel:** Bei type `"Laufen"` / `"Run"` ist `distance_km` immer `null`. Die HF-Zone ist die einzige Vorgabe — Distanz ergibt sich automatisch. DayCard zeigt für Laufeinheiten nur die Dauer, nie Kilometer.

**Kraft-description:** NUR `"Workout I"`, `"Workout II"` oder `"Workout III"` — Rotation I→II→III→I

**Invariante:** INSERT-only. Neue Version = neuer Datensatz. Niemals UPDATE auf bestehende Plans.

---

### coach_decisions
```sql
id                   UUID PRIMARY KEY
athlete_id           UUID → athletes.id
decision_type        TEXT    -- 'plan_generated' | 'weekly_review' | 'recovery_required' | 'midweek_feedback' | 'manual_plan_edit'
decision_summary     TEXT
reasoning            TEXT
related_plan_id      UUID nullable → weekly_plans.id
related_activity_id  UUID nullable → activities.id   -- gesetzt bei 'recovery_required'
created_at           TIMESTAMPTZ
```

---

### chat_messages
```sql
id          UUID PRIMARY KEY
thread_id   UUID               -- aus localStorage (coach_thread_id), pro Gesprächsfaden
athlete_id  UUID → athletes.id
role        TEXT               -- 'user' | 'assistant'
content     TEXT
chat_type   TEXT DEFAULT 'global'
activity_id UUID nullable
created_at  TIMESTAMPTZ
```

---

## 6. Umgebungsvariablen

```bash
# Client-seitig (VITE_ Prefix → im Browser-Bundle)
VITE_SUPABASE_URL=https://thjihbyyelqrrvdinzti.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_STRAVA_CLIENT_ID=260874
VITE_STRAVA_REDIRECT_URI=https://peakform-wheat.vercel.app/auth/callback

# Server-seitig (kein VITE_ Prefix → niemals im Browser-Bundle)
STRAVA_CLIENT_SECRET=...         # nur in /api/strava-token
ANTHROPIC_API_KEY=...            # nur in /api/analyse
```

---

## 7. API-Endpoints (Vercel Serverless Functions)

### POST `/api/analyse`
Claude API Proxy — niemals direkt vom Browser aufrufen.

**Request:**
```json
{ "prompt": "...", "max_tokens": 1024, "system": "...", "images": [{ "base64": "...", "mediaType": "image/jpeg", "label": "Aktuell — Frontal" }] }
```
`images` ist optional (generischer Claude Vision Support, aktuell von keinem Feature genutzt — Body Check-in, der ursprüngliche Anwendungsfall, wurde entfernt). Content-Blocks werden dann als `[label?, image, label?, image, ..., prompt]` an die Anthropic Messages API gebaut (Label-Text direkt vor dem zugehörigen Bild). Ohne `images` bleibt `content` ein reiner String wie bisher.

**Limits:** Prompt max 80.000 Zeichen, max_tokens Cap 4.096, max. 10 Bilder, max. 2.000.000 Base64-Zeichen pro Bild  
**Response:** `{ "text": "..." }`  
**Modell:** `claude-sonnet-4-6`

---

### POST `/api/strava-token`
Strava OAuth Token Exchange & Refresh & Deauthorize — STRAVA_CLIENT_SECRET bleibt server-seitig.

**Request (Exchange):** `{ "grant_type": "authorization_code", "code": "..." }`  
**Request (Refresh):** `{ "grant_type": "refresh_token", "refresh_token": "..." }`  
**Request (Deauthorize):** `{ "grant_type": "deauthorize", "access_token": "..." }` — proxied zu `POST strava.com/oauth/deauthorize`, benötigt keinen Client Secret, läuft aber trotzdem über diesen Endpoint statt direkt vom Browser (Konvention: kein direkter Browser-Call gegen `strava.com/oauth/*`); genutzt von `deauthorizeStrava()` (`src/lib/strava.ts`) im Rahmen der Kontolöschung (siehe Kapitel 9 „Profile.tsx" und Kapitel 18)  
**Response:** Strava Token Response (access_token, refresh_token, expires_at, athlete) bzw. `{ "success": true }` bei Deauthorize

---

## 8. Routen & Seiten

| Route | Komponente | Beschreibung |
|---|---|---|
| `/` | Home.tsx | Strava-Connect-Button; Auto-Redirect zu `/dashboard` wenn eingeloggt |
| `/auth/callback` | AuthCallback.tsx | OAuth-Code verarbeiten, athletes upsert, localStorage setzen |
| `/onboarding` | Onboarding.tsx | Verpflichtender 6-Schritte-Wizard; nicht über BottomNav erreichbar, kein AppHeader/Logout, kein Skip |
| `/dashboard` | Dashboard.tsx | Letzte 10 Aktivitäten + Filter + Alert-Banner |
| `/activity/:id` | ActivityDetail.tsx | Detail-Ansicht mit Charts, Hevy-Übungen, Claude-Analyse |
| `/profile` | Profile.tsx | Athleten-Profil mit Auto-Save |
| `/goals` | Goals.tsx | Saison-Ziele verwalten |
| `/plan` | WeeklyPlan.tsx | Wochenplan generieren + Review |
| `/chat` | Chat.tsx | Globaler Coach-Chat |

---

## 9. Seiten im Detail

### Home.tsx
- Zeigt Strava-Connect-Button
- `useEffect`: wenn `athlete_strava_id` in localStorage → sofortiger Redirect zu `/dashboard`

### AuthCallback.tsx
- Liest `?code=` aus URL
- Ruft `/api/strava-token` auf (server-side Token Exchange)
- Upsert in `athletes` via `strava_athlete_id` als Konflikt-Key
- Setzt `athlete_strava_id` in localStorage
- Redirect zu `/dashboard` (Layout-Guard in App.tsx leitet bei `onboarding_completed = false` sofort weiter zu `/onboarding`)

### Onboarding.tsx

Verpflichtender Wizard, läuft **einmalig** nach dem ersten Strava-Login. Kein Skip, kein "Später einrichten", kein "Zurück zum Dashboard" während des Flows. Kein AppHeader (kein Logout), keine BottomNav.

**State:** `currentStep` (1–6), lokale Formular-Daten für alle Schritte (Supabase-Save erst am Ende in Schritt 6). Fortschrittsanzeige: 6 Segmente, aktueller Schritt in `bg-brand-500` hervorgehoben. Navigation: "Weiter" (disabled bis Pflichtfelder erfüllt, via `canProceed()`), "Zurück" (außer Schritt 1, Daten bleiben im State).

| Schritt | Titel | Inhalt | Pflicht für "Weiter" |
|---|---|---|---|
| 1 | Willkommen | Logo, Willkommenstext, Name-Feld | Name ≥ 2 Zeichen |
| 2 | Sportarten | Trainingstage 1–7, Sportarten-Pills (alle drei, frei wählbar) mit Tage-Stepper; Amber-Warnung bei Σdays > Trainingstage (kein Blocker) | Trainingstage gesetzt + ≥1 Sportart |
| 3 | Erstes Ziel | Event-Name, Datum (muss in Zukunft liegen), Sportart-Dropdown (nur aus Schritt 2 gewählte Sportarten), Distanz/Höhenmeter/Notizen optional; Priorität automatisch `A` | Event-Name, Datum, Sportart |
| 4 | Leistungsdaten | Geschlecht, Geburtsjahr, Max HF (+ Tanaka-Button), Ruhe-HF, Gewicht, FTP (nur wenn Radfahren gewählt), 5k-Bestzeit MM:SS (nur wenn Laufen gewählt) — alles optional | keine (immer aktiv) |
| 5 | Coach-Stil | 3 Presets (Motivierend/Analytisch/Drill Sergeant, Default "Analytisch"), Freitext-Fokus optional | ein Stil gewählt |
| 6 | Zusammenfassung | Kompakte Übersicht aller Eingaben; Button "Los geht's" | — |

**"Los geht's" (Schritt 6):**
1. `season_goals` INSERT (Ziel aus Schritt 3, `priority: 'A'`, `active: true`)
2. `athletes` UPDATE: `name, gender, birth_year, max_hr, resting_hr, weight_kg, ftp_watts, best_5k_seconds, sport_types, training_days_per_week, coach_persona, onboarding_completed: true`
3. Bei Erfolg: `navigate('/dashboard', { replace: true })`
4. Bei Fehler (INSERT oder UPDATE schlägt fehl): Fehlermeldung unter der Zusammenfassung, User bleibt auf Schritt 6, State bleibt erhalten, erneuter Versuch möglich. `onboarding_completed` wird nur `true` gesetzt wenn beide Schreibvorgänge erfolgreich waren.

**Migration für Bestandsuser:** Beim Hinzufügen des Feldes wurden alle bestehenden `athletes`-Zeilen mit `name IS NOT NULL` per `UPDATE` auf `onboarding_completed = true` gesetzt — damit werden bereits eingerichtete Athleten (Markus) beim nächsten Login nicht in den Wizard geschickt.

**Sportarten-Auswahl ist von Feature-Flags entkoppelt:** Schritt 2 zeigt immer alle drei Sportarten zur Auswahl, unabhängig vom `features`-Feld in `athletes`. Grund: `features` kann erst gesetzt werden, wenn der `athletes`-Eintrag existiert (nach erstem Login), der Wizard startet aber sofort danach — ein Feature-Flag-Gate hier würde ein Henne-Ei-Problem erzeugen. Die Sichtbarkeit sportartspezifischer UI (FTP-Feld, Krafttraining-Sektion im Profil, Dashboard-Filter etc.) wird stattdessen ausschließlich durch die eigene `sport_types`-Wahl gesteuert — wählt der User eine Sportart nicht, bleiben die zugehörigen Bereiche automatisch ausgeblendet. `useFeatures()` bleibt für alle anderen Zwecke (z.B. komplettes Sperren von `coach_chat`, `goals`, `weekly_plan`) unverändert bestehen.

### Dashboard.tsx
- Lädt `athletes` by `strava_athlete_id` aus Supabase
- Holt letzte 10 Aktivitäten von Strava API (`per_page=10`)
- `syncActivitiesToSupabase(acts, athlete.id)` (aus `src/lib/strava.ts`): Upsert in `activities` (ohne `tss`, ohne `description`, ohne `claude_analysis` — `onConflict: 'strava_id'` fasst `claude_analysis` beim Update nie an, bestehende Analysen bleiben also unangetastet)
- Filter-Buttons: WeightTraining / Ride / Run mit FA6-Icons (VirtualRide/VirtualRun werden mitgefiltert)
- Logout-Icon: `localStorage.clear()` + Redirect
- Keine Nav-Kacheln mehr (ersetzt durch BottomNav)
- **Pagination — „Mehr laden" (4. Juli 2026):** Die Aktivitätsliste kommt live von der Strava API (nicht aus Supabase — Supabase ist reiner Write-Cache), daher paginiert „Mehr laden" ebenfalls gegen Strava statt gegen die `activities`-Tabelle
  - `fetchRecentActivities(accessToken, page = 1, perPage = 10)` (`src/lib/strava.ts`): `page`-Parameter ergänzt (vorher hartcodiert `per_page=10`, kein `page`), baut `?per_page=${perPage}&page=${page}`
  - State: `page` (aktuelle Strava-Seite, startet bei 1), `hasMore` (false sobald eine Seite `< 10` Aktivitäten liefert), `loadingMore`
  - `handleLoadMore()`: holt `getValidAccessToken(athlete)` erneut, lädt Seite `page + 1` via `fetchRecentActivities()`, hängt Ergebnis an `activities` an (`setActivities(prev => [...prev, ...more])`), ruft `syncActivitiesToSupabase(more, athlete.id)` für die neue Seite auf (identische Caching-Logik wie beim initialen Laden — Auto-Analyse läuft dadurch automatisch auch für nachgeladene Aktivitäten mit), aktualisiert danach `page`
  - **Feedback-Indikator für nachgeladene Aktivitäten:** Die Batch-Query aus „Feedback-Indikator auf Aktivitätskarten" (unten) wurde in `loadFeedbackMap(acts, athleteId)` extrahiert — initiales Laden und `handleLoadMore()` rufen dieselbe Funktion auf; `handleLoadMore()` merged das Ergebnis in den bestehenden `feedbackMap`-State (`setFeedbackMap(prev => ({...prev, ...moreFbMap}))`) statt ihn zu ersetzen
  - **Sportart-Filter bleibt rein clientseitig:** filtert weiterhin nur das (wachsende) `activities`-Array im State — kein serverseitiger Filter-Parameter nötig, da Strava-Pagination unabhängig vom Filter immer "weitere Aktivitäten insgesamt" nachlädt
  - Button „Mehr laden" unterhalb der Aktivitätsliste, nur sichtbar wenn `hasMore`; während `loadingMore` Spinner + „Lädt…" statt Label; nach Ende der Historie (`!hasMore`) dezenter Hinweistext „Keine weiteren Aktivitäten" — nur wenn bereits mehr als die initialen 10 geladen wurden (`activities.length > 10`), nicht beim allerersten Laden mit weniger als 10 Aktivitäten insgesamt
- **Aktivitätsliste — `ActivityIcon`:** Sportart-Icon in der Karten-Kopfzeile (`flex items-center gap-2`) trägt `flex-shrink-0`, damit es bei langen Aktivitätsnamen (die den Zeilenplatz knapp machen) nicht vom Flexbox-Schrumpfalgorithmus mitverkleinert wird — ohne `flex-shrink-0` erben Flex-Kinder standardmäßig `flex-shrink: 1`, wodurch das SVG-Icon neben einem sehr langen `truncate`-Namen sichtbar kleiner wirkte als bei kurzen Namen (Bugfix 3. Juli 2026)
- **Feedback-Indikator auf Aktivitätskarten** (4. Juli 2026, seit Verlagerung des Mid-Week-Feedbacks nach `ActivityDetail.tsx`, siehe Kapitel 9 „ActivityDetail.tsx — Mid-Week-Feedback"): Nach dem Laden der Aktivitätsliste ein einzelner Batch-Query auf `coach_decisions` (`decision_type = 'midweek_feedback'`), gejoint über `activities!related_activity_id!inner(strava_id)` und gefiltert mit `.in('activities.strava_id', acts.map(a => a.id))` — nötig weil `coach_decisions.related_activity_id` auf die Supabase-UUID zeigt, `act.id` hier aber die Strava-ID ist. Ergebnis wird zu `feedbackMap: Record<number, true>` (Strava-ID als Key) reduziert — nur Existenz relevant, nicht der Text. Karten mit Eintrag zeigen ein dezentes `IconCommentFilled` (`text-brand-400`, `size={11}`) links neben dem Datum. Tap auf die Karte navigiert wie gewohnt zu `ActivityDetail.tsx` — kein separates Bottom-Sheet auf Dashboard-Ebene.

**Auto-Analyse nach Sync (`syncActivitiesToSupabase()`, 2. Juli 2026):**
- Nach dem Upsert startet fire-and-forget (nicht `await`et — Dashboard/WeeklyPlan laden sofort normal weiter) ein Hintergrundjob: `SELECT * FROM activities WHERE athlete_id = ... AND claude_analysis IS NULL ORDER BY date ASC`
- Jede gefundene Aktivität wird **sequenziell** (nicht `Promise.all`) mit `analyzeActivity()` analysiert — sequenziell, damit eine Recovery-Entscheidung aus `coach_decisions` bei der Analyse der nächsten Aktivität bereits im Kontext verfügbar ist
- Fehlgeschlagene Einzel-Analysen werden geloggt (`console.error`), blockieren aber weder die Schleife noch den Aufrufer — die Aktivität bleibt einfach ohne `claude_analysis` (siehe „Fallback" in Kapitel 10 und „Polling" in Kapitel 9)
- Die gesamte fire-and-forget-IIFE ist in `try/catch` gewrappt, damit auch ein Fehler beim initialen `SELECT` nicht als unhandled promise rejection auftaucht
- Genutzte Implementierung: `analyzeActivity()` aus `src/lib/activityAnalysis.ts` — dieselbe Funktion, die auch der „Neu analysieren"-Button in `ActivityDetail.tsx` und der Plan/Review-Fallback in `WeeklyPlan.tsx` aufrufen
- **Race-Fix — Claim vor jedem `analyzeActivity()`-Aufruf (9. Juli 2026):** Verifiziert per Live-Test, dass React StrictMode (Dev-Doppel-Mount des Dashboard-`useEffect`) und/oder ein gleichzeitiger Sync über `WeeklyPlan.tsx` denselben `claude_analysis IS NULL`-Treffer parallel aufgreifen und zwei echte Claude-Calls für **eine** Aktivität auslösen konnten. Fix: `claimActivityForAnalysis(activityId)` (neu, `src/lib/activityAnalysis.ts`) schreibt vor dem eigentlichen Aufruf atomar `activities.analysis_claimed_at = now()` per conditional `UPDATE ... WHERE claude_analysis IS NULL AND (analysis_claimed_at IS NULL OR analysis_claimed_at < now() − 2min)`; Postgres wendet WHERE-Check und Schreibvorgang pro Zeile atomar an, sodass bei zwei parallelen Sweeps nur einer den Claim gewinnt (Rückgabe `true`/`false` über `.select('id')`-Trefferzahl) — der Verlierer überspringt die Aktivität via `continue`. `analyzeActivity()` setzt `analysis_claimed_at` sowohl bei Erfolg als auch bei Fehlschlag wieder auf `null` zurück (Fehlerfall: eigener `try/catch`, best-effort). Ein 2-Minuten-Timeout macht einen verwaisten Claim (z. B. Tab während der Analyse geschlossen) beim nächsten Sync automatisch wieder claimbar — kein manueller Reset nötig. Derselbe Claim-Schritt läuft auch im Fallback `closeOutstandingAnalyses()` (Kapitel 10). Der manuelle „Neu analysieren"-Button in `ActivityDetail.tsx` umgeht den Claim bewusst — er soll unabhängig vom Lease-Status jederzeit sofort auslösen können. Live verifiziert: zwei parallele `claimActivityForAnalysis()`-Aufrufe auf dieselbe Aktivität liefern `true`/`false`, nie `true`/`true`.

**Echtzeit-Alert nach Strava-Sync:**
- Persistiert je Plan-Version über `coach_decisions` (`decision_type='realtime_alert_dismissed'`, `related_plan_id`) — kein `sessionStorage`-Gate mehr, siehe Kapitel 18.3 Bugfix 12. Juli 2026
- Lädt aktuellen Wochenplan + neueste Aktivität dieser Woche parallel aus Supabase
- Claude-Call (`max_tokens: 150`) zur Konflikt-Erkennung — antwortet ausschließlich JSON: `{"conflict": bool, "message": string|null}`
- Bei Konflikt: Amber-Banner mit Claude-generierter Erklärung
- Banner-Buttons: "Plan anpassen" (→ Claude-Call + Modal) / "Verwerfen"
- "Plan anpassen": Claude-Call mit Plan-JSON + Konflikt-Beschreibung → Text-Modal

### ActivityDetail.tsx

**Identifier-Konvention Aktivitäts-Navigation:** Die Route `/activity/:id` erwartet in `:id` immer die **Strava-BIGINT-ID** (`activities.strava_id`), niemals die Supabase-UUID (`activities.id`). Grund: `ActivityDetail.tsx` lädt die Aktivität via `useParams()` → `.eq('strava_id', Number(id))` (nicht `.eq('id', id)`). Jede Stelle, die zu `/activity/:id` navigiert, muss `strava_id` übergeben:
- `Dashboard.tsx`: `act.id` ist hier bereits die Strava-ID, da `act` vom Typ `StravaActivity` (direkt von der Strava API) ist — kein Widerspruch zur Konvention.
- `WeeklyPlan.tsx` (`DayCard`-`onPress`): `match.activity` ist hier vom Typ `Activity` (Supabase-Row) — es muss explizit `match.activity.strava_id` verwendet werden, **nicht** `match.activity.id`. (War Ursache eines Bugs: Klick auf absolvierte Aktivität im Wochenplan führte zu "Aktivität konnte nicht geladen werden", weil `Number(<uuid>)` zu `NaN` wird.)

**Datumszeile** (3. Juli 2026): Unter dem Aktivitätsnamen zeigt `new Date(activity.date).toLocaleDateString('de-DE', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})` gefolgt von `· ` + `toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'})` + ` Uhr` die lokale Startzeit, z. B. „Donnerstag, 2. Juli 2026 · 06:05 Uhr". `toLocaleDateString`/`toLocaleTimeString` formatieren beide bereits in der Browser-Lokalzeit (kein manuelles UTC-Offset nötig) — anders als der Lokalzeit-Bugfix vom 2. Juli 2026 (Kapitel 11), der `date.slice(0,10)` auf rohen UTC-ISO-Strings betraf; hier wird nie auf den rohen String zugegriffen, sondern immer über `new Date(activity.date)` + `toLocale*`-Methoden.

**Sportartabhängige Darstellung** (`isRun` = `['Run', 'VirtualRun', 'TrailRun']`):

**Lauf (Run / VirtualRun / TrailRun):**
- Stats-Grid Zeile 1: **Distanz** | **Dauer** | **Ø Pace** (min/km)
- Stats-Grid Zeile 2: **Ø HF** | **Max HF** | **Ø Kadenz** (wenn cadence-Stream vorhanden, sonst 5 Kacheln)
  - Ø Kadenz: `stats.avgCadence * 2` spm (Strava-Stream gibt einseitige Schritte → mal 2 = Schritte/min); Format: `"172 spm"`
  - Pace-Formel: `paceMinKm = 60 / speedKmh`; Anzeige: `"6:58 min/km"`
  - Kein Max Pace (velocity_smooth-Stream unzuverlässig), *kein* Höhenmeter, *kein* NP
- Charts: **Herzfrequenz** (rot) — *kein* Pace-Chart, *kein* Watt-Chart, *kein* Höhenprofil
- **Kilometer-Splits-Tabelle** (unterhalb Charts, oberhalb KI-Analyse)
  - Spalten: KM | ZEIT | PACE | Ø HF
  - Ganze Kilometer: `"km 1"`, `"km 2"` etc.; Letzter unvollständiger Split (`distance < 900m`): tatsächliche Distanz `"0.13 km"`, PACE = `"—"`
  - ZEIT: `moving_time` via `formatDuration`; PACE: `"M:SS min/km"` via `formatPace(moving_time / (distance/1000))`; Ø HF: `"{wert} bpm"` oder `"—"`
  - Datenquelle: **`splits_metric_json`** (Cache-first aus Supabase; beim ersten Öffnen via `GET /activities/{id}` → `splits_metric` Feld → in Supabase gecacht)
  - `moving_time` statt `elapsed_time` → Pausen korrekt ausgeblendet, identisch zur Strava-Anzeige
  - State: `runSplits: RunSplit[]` (wird in useEffect befüllt)
  - Card-Design: `bg-slate-800 rounded-xl`, abwechselnd `bg-slate-700/20`
- Claude-Analyse-Button → `/api/analyse` → gespeichert in `activities.claude_analysis`

**Rad (Ride / VirtualRide / MountainBikeRide / GravelRide):**
- Stats-Grid: Dauer, Ø HF, Distanz, Höhenmeter, Ø/Max Tempo (km/h), Max HF, NP, Ø/Max Watt, Trittfrequenz (kontextabhängig)
- Charts: Watt (amber), Herzfrequenz (rot), Höhenprofil (grün)
- Rundentabelle: #, Dauer, Distanz, Ø Watt, Ø HF, Ø RPM
- Claude-Analyse-Button → `/api/analyse` → gespeichert in `activities.claude_analysis`

**Krafttraining (WeightTraining):**
- Hevy-Description aus `activities.description` (Cache-first, dann Strava Detail-Endpoint)
- Parser `parseHevyDescription()`: parst Sets mit Gewicht×Wiederholungen oder Körpergewicht-Wiederholungen
- Übungskarten: Name, Muskelgruppe-Pill (aus 50+ Keyword-Lookup), Volumen-Pill, Set-Tags
- Gesamtvolumen-Banner
- Claude-Analyse: Volumen & Intensität / Übungsanalyse / Stärken / Empfehlung

**Coach-Routing (`getSpecialistPrompt(activityType)`, in `src/lib/activityAnalysis.ts`):**
- Gibt `{ specialist: string|null, sport: string|null }` zurück
- `specialist` = sportspezifischer Spezialist-Prompt (wird auf `buildCoachSystemPrompt()` aufgesattelt)
- `sport` = `'running'` | `'cycling'` | `'strength'` | `null`
- `analyzeActivity()` lädt `buildCoachSystemPrompt(aId, sport)` + `buildCoachContext()` + `buildSpecialistContext()` parallel

**Recovery-Extraktion (`triggerRecoveryExtraction(analysisText, athleteId, activityId)`, in `src/lib/activityAnalysis.ts`):**
- Fire-and-forget Helper — läuft nach jeder erfolgreichen `analyzeActivity()` ODER beim Laden einer bestehenden Analyse
- Mini-Claude-Call (`max_tokens: 150`): extrahiert `{has_restriction, restriction_until, description}` als JSON
- Bei `has_restriction: true` → INSERT in `coach_decisions` (`decision_type = 'recovery_required'`, `related_activity_id = activityId`)
- **On-load Recovery-Check:** Wenn `claude_analysis` existiert aber kein `coach_decisions`-Eintrag mit `related_activity_id = act.id` und `type = 'recovery_required'` → Extraction wird automatisch nachgeholt

**Auto-Analyse (2. Juli 2026):**
- Neue Aktivitäten werden nicht mehr manuell per Klick analysiert, sondern automatisch im Hintergrund direkt nach dem Strava-Sync (siehe `syncActivitiesToSupabase()` in Dashboard.tsx oben) — der Analyse-Button heißt jetzt durchgängig **„Neu analysieren"** und bleibt jederzeit verfügbar (überschreibt bestehende `claude_analysis` bei Klick), unabhängig davon ob bereits eine Analyse existiert
- `runAnalysis()` in `ActivityDetail.tsx` ruft dafür nur noch `analyzeActivity(activity, athleteId)` aus `src/lib/activityAnalysis.ts` auf und lädt danach `claude_analysis` neu für die Anzeige — die eigentliche Analyse-Logik lebt vollständig in der Lib (reines Refactoring, kein Verhaltensunterschied für die UI)
- **Polling bei laufender Hintergrund-Analyse:** Ist `claude_analysis` beim Laden der Seite noch `null`, wird `awaitingBackgroundAnalysis` gesetzt; ein `useEffect` pollt danach alle 3s (max. 10 Versuche = 30s) erneut `claude_analysis`. Solange gepollt wird, zeigt die Seite statt eines leeren Zustands den Hinweis „Analyse läuft im Hintergrund…" (Spinner). Nach 10 erfolglosen Versuchen fällt die UI automatisch in den normalen „Neu analysieren"-Zustand zurück. Ein manueller Klick auf „Neu analysieren" bricht laufendes Polling sofort ab.

**Markdown-Renderer** (`renderMarkdown`): h1-h3, Bullet-Lists, Blockquotes, `**fett**`, HR, Skip-Tabellen und Code-Blöcke

**Button-Layout „Neu analysieren" + „Feedback" + „Roast Me" (4. Juli 2026, Ausrichtung/Typografie korrigiert 4. Juli 2026):**
- **Zeile 1 — „Neu analysieren" + „Feedback":** gemeinsamer `flex justify-between gap-3`-Container — „Neu analysieren" bleibt jederzeit sichtbar links, content-sized (kein `w-*`); „Feedback" erscheint rechtsbündig daneben **nur wenn `claude_analysis` bereits existiert**: `IconCommentOutline` (noch kein Feedback für diese Aktivität) oder `IconCommentFilled` in `text-brand-400` (Feedback bereits vorhanden) + Label „Feedback geben" bzw. „Feedback bearbeiten"
- **Zeile 2 — „Roast Me":** eigene Zeile unterhalb der KI-Analyse-Card, **nur wenn `claude_analysis` bereits existiert**, zentriert via `flex justify-center` mit Button auf `w-1/2` (identische Breite zur vorherigen 50%-Grid-Spalte)
- **Einheitliche Typografie:** alle drei Buttons nutzen `text-base font-semibold` (Referenz: „Neu analysieren"), Icons (`IconCommentOutline/Filled`, `IconRoast`) einheitlich `size={16}` (zuvor uneinheitlich: „Feedback"/„Roast Me" auf `text-sm`, „Roast Me" zusätzlich `font-bold`, Icons auf `size={14}`)

**Roast Me (vereinfacht 3. Juli 2026, vormals „Spaß-Analyse" mit 3 Modi; nutzt seit 4. Juli 2026 vorhandenes Mid-Week-Feedback als Zusatz-Input, siehe unten):**
- **Freischalt-Logik (5. Juli 2026):** Roast Me ist erst nutzbar, nachdem seit dem Onboarding (`athletes.created_at`, entspricht dem ersten Strava-Login) mindestens 3 eigene Aktivitäten synchronisiert wurden — verhindert, dass die beim allerersten Strava-Sync automatisch mitimportierten historischen Aktivitäten (Strava liefert standardmäßig die letzten Aktivitäten unabhängig von deren Alter) die Freischaltung auslösen. `checkRoastUnlock(athleteId, createdAt)` (lokal in `ActivityDetail.tsx`) zählt `activities` mit `athlete_id = athleteId AND date >= createdAt` (`count: 'exact', head: true`) und liefert `{unlocked: count >= 3, remaining: max(0, 3 - count)}`; wird einmalig direkt nach dem Laden des Athleten aufgerufen (nicht `await`et, läuft parallel zum restlichen Seiten-Load), Ergebnis in State `roastUnlock`. Solange `roastUnlock` noch `null` ist (Check läuft), bleibt der Button im normalen (farbigen) Zustand — verhindert Grau-Flackern bei Bestandsusern, deren Schwelle längst erreicht ist. Bei `unlocked: false`: Button bleibt sichtbar und klickbar (kein natives HTML `disabled`, nur visuell via `bg-slate-600 opacity-40 cursor-not-allowed` statt Gradient — dimmt auch die Flammen-Icons mit), Klick löst **keinen** Claude-Call aus, sondern zeigt 2,5s einen Toast (`roastLockedNotice`-State, gleiches Styling wie der Mid-Week-Feedback-Toast) mit exakter Restanzahl: „Noch 1 Aktivität synchronisieren, um Roast Me freizuschalten." bzw. „Noch N Aktivitäten…". Bei `unlocked: true` unverändertes Verhalten wie zuvor.
- Optionaler, rein unterhaltsamer KI-Kommentar zur Aktivität — 1 Modus, kein Modus-Auswahl mehr (`buildRoastPrompt` in `src/lib/funModePrompts.ts`)
- Button „🔥 Roast Me 🔥" (Flammen-Icon links+rechts, Gradient orange→rot, weißer fetter Text), eigene zentrierte Zeile (siehe oben)
- Bei Klick: `getRoastAnalysis(activity, {name}, stats, exercises, userFeedback?)` (lokal in `ActivityDetail.tsx`) ruft `/api/analyse` **direkt** auf (`fetch`, `max_tokens: 500`) — **kein** `buildCoachSystemPrompt()`, **kein** `buildCoachContext()`, **kein** `buildSpecialistContext()`. System-Prompt kommt ausschließlich aus `buildRoastPrompt({name, sport, userFeedback})`
- `sport` wird per `sportFromActivityType(activity.type)` aus `activity.type` abgeleitet — identisches Mapping zu `getSpecialistPrompt()` in `activityAnalysis.ts` (Run/VirtualRun/TrailRun→running, Ride/VirtualRide/MountainBikeRide/GravelRide→cycling, WeightTraining/Workout→strength)
- User-Prompt (`buildRoastStatsText()`) ist ein sportart-spezifischer Rohdaten-Stats-Block dieser einen Aktivität: Laufen bekommt Ø-Pace (aus Distanz/Dauer berechnet via `speedToPace()`) + Ø-Kadenz in spm; Rad bekommt NP/Ø-Watt + Ø-Trittfrequenz in rpm; Kraft bekommt pro Übung Gewicht×Wiederholungen je Satz + Muskelgruppe (`primaryMuscleLabel()`) + Gesamtvolumen. Ohne erkannte Sportart (`sport === null`) bleibt es beim generischen Block (Distanz, Ø/Max HF)
- **`userFeedback`-Parameter:** `buildRoastPrompt({name, sport, userFeedback?: string})` fügt bei vorhandenem Text einen `feedbackHint`-Absatz vor dem `vocabHint` ein: „Die Person hat selbst folgendes Feedback zu dieser Einheit gegeben: „{text}" — nutze das schamlos als zusätzliches Roast-Material, mach dich genüsslich darüber lustig." `ActivityDetail.tsx` reicht dafür das bereits geladene `feedback.reasoning` (siehe „Mid-Week-Feedback" unten) durch — Roast Me **liest** das Feedback nur, schreibt es aber nirgends zurück
- Ton: bewusst bösartiger/schonungsloser als der frühere „Roast"-Modus — South-Park-artig statt nur frech; bleibt trotzdem ausschließlich bei Trainingsdaten (Pace/Watt/Zeit/Distanz/Gewicht/HF), niemals Körper/Aussehen/Charakter
- Personalisierung: `athlete.name` wird beim Laden der Aktivität bereits mitgeladen (kein zusätzlicher Supabase-Call) und in den State (`athleteName`) übernommen
- Ergebnis lebt ausschließlich in React-State (`roastResult`, `roastLoading`, `roastError`) — **wird nirgends persistiert**, verschwindet bei Seiten-Reload; erneuter Klick überschreibt den State und triggert einen neuen Claude-Call
- Ergebnis-Card im Flammen-Look: Gradient `from-red-950/40 to-orange-950/30`, orangener Rand, Header „🔥 Geröstet 🔥"; Card hat kein `max-h`/`overflow-hidden`, wächst mit `height: auto` vollständig mit dem Text
- Auto-Scroll: `useEffect` beobachtet `roastResult` und ruft `roastResultRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })` auf, sobald das Ergebnis gesetzt ist — Ansicht springt automatisch zum Card-Header, kein manuelles Scrollen nötig
- **Vollständig isoliert vom Coach-Gedächtnis:** taucht in keinem zukünftigen `buildCoachContext()`-Aufruf auf, erzeugt keinen `coach_decisions`-Eintrag, schreibt nie in `activities.claude_analysis` — beeinflusst niemals spätere Coaching-Entscheidungen (Plan-Generierung, Reviews, Recovery-Extraktion); das gilt auch wenn Roast Me vorhandenes Mid-Week-Feedback als Input liest
- Icon: `IconRoast` (`FaFire`) in `src/lib/icons.ts`; `IconSarcastic`/`IconSexy` entfernt

**Mid-Week-Feedback (4. Juli 2026, aus `WeeklyPlan.tsx` hierher verschoben, siehe Kapitel 10):**
- Button neben „Neu analysieren" in Zeile 1 (siehe oben). Klick öffnet ein Bottom-Sheet-Modal (`fixed inset-0 bg-black/70`, Klick auf Backdrop schließt) mit Freitextfeld, „Speichern" (disabled bei leerem Text) und „Abbrechen" — identisches Design wie zuvor in `WeeklyPlan.tsx`
- **Laden:** Beim Öffnen von `ActivityDetail.tsx` ein Query auf `coach_decisions` (`decision_type = 'midweek_feedback'`, `related_activity_id = activity.id`) via `.maybeSingle()` — einzelner Eintrag statt Map, da hier nur eine Aktivität relevant ist. State: `feedback: {id, reasoning} | null`
- **Erneutes Öffnen:** Modal wird mit dem vorherigen `reasoning`-Text vorausgefüllt (`openFeedbackModal()`)
- **Speicherung:** Klick auf „Speichern" → INSERT in `coach_decisions` (`decision_type: 'midweek_feedback'`, `decision_summary`: erste 100 Zeichen, `reasoning`: vollständiger Text, `related_activity_id: activity.id`) falls noch kein Eintrag existiert, sonst UPDATE auf `decision_summary`/`reasoning` — identische Logik wie zuvor in `WeeklyPlan.tsx`, nur der Ladeort hat sich geändert
- **Toast:** Erfolg → „Danke — wird beim nächsten Plan berücksichtigt ✓" (`bg-brand-500`, 2.5s, `fixed top-4` zentriert). Fehler → „Feedback konnte nicht gespeichert werden" (`bg-red-500`), Modal bleibt offen, Text bleibt erhalten
- **Sichtbarkeit im Coach-Kontext:** unverändert — `buildCoachContext()` lädt die letzten 5 `coach_decisions` ohne Filter auf `decision_type` (siehe Kapitel 11), `midweek_feedback`-Einträge erscheinen dort automatisch
- **Dashboard-Indikator:** siehe Kapitel 9 „Dashboard.tsx — Feedback-Indikator auf Aktivitätskarten"
- Icons: `IconCommentOutline` / `IconCommentFilled` in `src/lib/icons.ts` (unverändert, nur der Verwendungsort hat sich geändert)
- **Freitextfeld-Schriftgröße:** `text-base` (16px), nicht `text-sm` — unter 16px löst iOS Safari beim Fokussieren automatisches Zoomen aus (Bugfix 4. Juli 2026, betraf app-weit alle `<input>`/`<textarea>`/`<select>`-Felder, siehe Changelog-Kopf)

### Profile.tsx

**Struktur:** Alle Sektionen als einklappbares `AccordionSection`-Akkordeon. Reihenfolge:

| # | Sektion | defaultOpen | Bedingung |
|---|---|---|---|
| 1 | ALLGEMEIN | true | immer |
| 2 | TRAINING | true | immer |
| 3 | LEISTUNGSDATEN | false | immer |
| 4 | ZIEL & COACH | false | immer |
| 5 | TRAININGSPHASE | false | immer |
| 6 | KRAFTTRAINING | false | nur wenn `strength` in sport_types |

Darunter, außerhalb des Akkordeons: rot abgesetzte **„Konto löschen"**-Sektion (kein Akkordeon-Eintrag, immer sichtbar) — siehe eigener Abschnitt unten.

**`AccordionSection`-Komponente** (in Profile.tsx, kontrolliert):
- Props: `title`, `subtitle`, `open`, `onToggle`, `children`
- Header: Titel (uppercase, xs) links + Subtitle (truncated, rechts vom Titel) + Chevron rechts
- Subtitle nur sichtbar wenn eingeklappt
- `maxHeight`-Transition 300ms beim Aufklappen
- `min-h-[3rem]` für Touch-Target ≥ 48px
- `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` wenn Sektion neu geöffnet wird (via `prevOpenRef`)
- Accordion-Zustand in Profile verwaltet (6 useState: `generalOpen`, `trainingOpen`, `performanceOpen`, `goalCoachOpen`, `phaseOpen`, `strengthOpen`)

**Subtitles (werden als Preview angezeigt wenn eingeklappt):**
- ALLGEMEIN: `name || "—"`
- TRAINING: `"5 Tage/Woche · Radfahren, Laufen, Krafttraining"`
- LEISTUNGSDATEN: `"FTP 229W · Max HF 182 · 76kg · 5k 25:51"` (nur nicht-null Felder)
- ZIEL & COACH: `"Event, Muskelaufbau · Coach: Analytisch"`
- TRAININGSPHASE: `"Phase 2 — Grundlage (automatisch)"` oder `"… (manuell gesetzt) ⚠"`
- KRAFTTRAINING: Equipment-Liste `"Kurzhanteln 32kg, Bänder"` + `"Schultern, Brust, Arme (Priorität)"`

**Sektionsinhalte:**

*ALLGEMEIN:*
- Name (Textfeld)
- Geschlecht: Segmented Control (Männlich / Weiblich / Divers) → speichert `'male'|'female'|'diverse'`
- Geburtsjahr: Number Input (1940–2010), Hint: "Wird für Altersberechnung und Max HF Schätzung verwendet"

*TRAINING:*
- Trainingstage pro Woche: Button-Grid 1–7
- Sportarten: Pills (Radfahren / Laufen / Krafttraining) mit Akkordeon-Stepper
  - Pill zeigt aktiv (brand-Farben) wenn Sportart in `sport_types`
  - Pill-Klick: Öffnet/schließt den Stepper; fügt Sportart mit 1 Tag hinzu wenn noch nicht vorhanden — aber nur wenn `totalDays < trainingDaysNum`
  - Stepper − bei 1 Tag: Sportart wird entfernt, `focusedSport` → null
  - Stepper + deaktiviert wenn `totalDays >= trainingDaysNum`; Tooltip: "Maximale Trainingstage erreicht"
  - Trainingstage reduzieren → Amber-Warnung wenn `totalDays > trainingDaysNum`; kein Auto-Save

*LEISTUNGSDATEN:*
- Max HF (bpm): immer sichtbar; "Tanaka berechnen"-Button neben dem Feld (nur sichtbar wenn Geburtsjahr eingetragen); Button triggert direkten Save ohne Debounce; Hint: "Gemessener Wert empfohlen. Ohne Wert: Tanaka-Formel (208 − 0.7 × Alter) als Schätzung."
- Ruheherzfrequenz (bpm): immer sichtbar, Hint: "Morgens vor dem Aufstehen messen"
- Gewicht (kg): immer sichtbar
- FTP (W): nur wenn cycling aktiv
- 5k Bestzeit (MM:SS): nur wenn running aktiv — konvertiert zu/von `best_5k_seconds`
  - Validierung live: Format MM:SS, Minuten 10–59, Sekunden 0–59
- **"Zuletzt aktualisiert"** unter jedem Feld (NULL → kein Text; veraltet → amber ⚠)
  - Schwellwerte: FTP > 60 Tage, Max HF > 365 Tage, Gewicht > 30 Tage, 5k > 90 Tage
- **`_updated_at` Auto-Update:** `field_updated_at = NOW()` wenn Wert geändert und nicht null (`origFtp/origMaxHr/origWeight/origBest5k` Refs)

*ZIEL & COACH:*
- Ziele (Mehrfachauswahl): Event / Muskelaufbau / Gewicht reduzieren
- Coach-Stil (Einfachauswahl): Motivierend / Analytisch / Drill Sergeant
- Coach-Fokus: Freitext-Textarea

*TRAININGSPHASE:*
- Auto-berechnete Phase anzeigen
- Segmented Control: Auto | Readaptation | Grundlage | Wettkampf | Taper
- Amber-Hinweis wenn Override aktiv

**Feature-Gates (via `useFeatures(athlete)` aus `src/lib/features.ts`):**
- Sportart-Pill Radfahren: nur wenn `features.cycling`
- Sportart-Pill Krafttraining: nur wenn `features.strength`
- Laufen ist immer sichtbar (Basis-Feature)
- KRAFTTRAINING-Sektion: nur wenn `hasStrength && features.strength`
- Dashboard Filter-Button WeightTraining: nur wenn `features.strength`
- Dashboard Filter-Button Radfahren: nur wenn `features.cycling`

*KRAFTTRAINING (nur wenn `hasStrength && features.strength`):*
- **Teil A — Equipment:** Checkboxen (Kurzhanteln / Bänder / Körpergewicht / Klimmzugstange + Gym als Mutex)
  - Bei Kurzhanteln aktiv: Number-Input `bis X kg`
  - Gym aktiv → alle anderen disabled + ausgegraut
- **Teil B — Körperziele** (nur wenn `showAesthetic` = `"Muskelaufbau"` oder `"Gewicht reduzieren"` in bodyGoals):
  - Drag & Drop Muskelgruppen-Ranking (7 Gruppen, via @dnd-kit)
  - **Drag-Griff statt ganzer Zeile (Bugfix 4. Juli 2026):** `attributes`/`listeners` aus `useSortable()` hängen nur am `IconGrip`-Button rechts in `SortableMuscleItem`, nicht mehr an der ganzen Zeile — verhindert, dass normales vertikales Scrollen auf Mobile als Drag-Start interpretiert wird. Sensor: `PointerSensor` mit `activationConstraint: { delay: 200, tolerance: 8 }` statt reiner `distance`-Schwelle.
  - Freitext-Feld für Besonderheiten
- **Auto-Open:** Wenn Krafttraining neu aktiviert wird → `setStrengthOpen(true)` direkt in `toggleSport` (nicht via useEffect, damit kein ungewolltes Aufklappen beim initialen DB-Load)

**Auto-Save:** 800ms Debounce. Kein manueller Save-Button. Status-Indikator (`fixed top-4 right-4 z-50`, Speichert… / ✓ Gespeichert).
- `hasSportViolation`, `totalDays`, `trainingDaysNum` werden **vor** dem Auto-Save-`useEffect` deklariert
- `hasSportViolation` in der Dep-Liste — Debounce-Timer startet neu wenn Verletzung aufgelöst wird

**Konto löschen (Self-Service, seit 12. Juli 2026):**
- Rot abgesetzte Sektion ganz unten (`border-t border-red-900/40`, roter Titel/Text), Kurzbeschreibung der Konsequenzen, Button öffnet Bottom-Sheet-Modal (`deleteState`-State-Machine: `closed | confirm | deleting | error | strava-warning`)
- **Bestätigung:** Modal wiederholt die Konsequenzen, Zwei-Stufen-Bestätigung — expliziter roter Button „Ja, endgültig löschen" neben „Abbrechen" (kein simples „OK")
- **Ablauf (`handleDeleteAccount()`):**
  1. `deauthorizeStrava(athlete.strava_access_token)` (`src/lib/strava.ts`) — POST `/api/strava-token` mit `grant_type: 'deauthorize'`, proxied zu `strava.com/oauth/deauthorize`; fehlertolerant (`try/catch` → `false`), läuft **vor** der DB-Löschung, da danach kein gültiger Token mehr existiert
  2. `supabase.rpc('delete_athlete_account', { p_athlete_id: athlete.id })` — `athlete.id` kommt ausschließlich aus dem im Session-State geladenen Athleten, niemals aus Query-Parametern/Formularfeldern
  3. RPC-Ergebnis `!== 1` oder Fehler → `deleteState = 'error'`, Fehlermeldung im Modal, Athlet bleibt eingeloggt, kein Redirect
  4. Deauthorize fehlgeschlagen (Schritt 1 `false`), DB-Löschung aber erfolgreich → `deleteState = 'strava-warning'`, Hinweis auf manuelles Trennen unter strava.com/settings/apps, Redirect erst nach Klick auf „Verstanden"
  5. Beides erfolgreich → sofort derselbe Cleanup wie Logout (`localStorage.clear()` + `sessionStorage.clear()` + `pf_athlete_id`-Cookie löschen) + Redirect zu `/`
- **Supabase-Funktion `delete_athlete_account(p_athlete_id UUID)`** (SECURITY DEFINER, siehe Kapitel 18 „Multi-User Vorbereitung"): löscht in einer Transaktion `chat_messages` → `coach_decisions` → `weekly_plans` → `activities` → `season_goals` → `athletes` (Reihenfolge wegen FK-Constraints), `RETURNS INTEGER` = Anzahl gelöschter `athletes`-Zeilen (0 oder 1); wirft eine der DELETEs einen Fehler, rollt Postgres automatisch die gesamte Funktion zurück (kein Teilzustand)
- Verifiziert per Test-Athlet (alle 6 Tabellen befüllt) → RPC-Aufruf → SQL-Verifikation: alle 6 Tabellen leer für die gelöschte `athlete_id`, Zeilenzahlen der beiden echten Athleten (Markus, Halblapp) vor/nach identisch (kein Kollateralschaden)

### Goals.tsx
- Lädt alle `season_goals` mit `active = true`, sortiert nach `event_date`
- A-Event Countdown (größter Block wenn vorhanden, nur für zukünftige Events)
- Ziel-Liste: sortiert A → B → C
- Add/Edit-Modal: Event-Name, Datum, Priorität A/B/C, Sportart, Distanz, Höhenmeter, Notizen
- Deaktivieren: `active = false` (kein DELETE)
- Sportarten im Modal: Radfahren / Laufen / Triathlon / Schwimmen / Wandern / Krafttraining

### WeeklyPlan.tsx
→ Eigener Abschnitt 10.

### Chat.tsx
- Thread-ID aus `localStorage` (`coach_thread_id`); `crypto.randomUUID()` beim ersten Besuch
- Lädt letzte 50 Messages aus `chat_messages` für aktuellen Thread
- Supabase-first Flow:
  1. User-Message → INSERT in `chat_messages`
  2. Reload aus DB
  3. `buildCoachContext(athleteId, threadId)` aufrufen
  4. Claude-Call via `/api/analyse` (max_tokens: 1024)
  5. Assistant-Response → INSERT in `chat_messages`
  6. Reload aus DB
- "Neues Gespräch": neue UUID in localStorage, leere Messages
- Textarea: auto-resize bis max 128px; Enter = senden, Shift+Enter = neue Zeile
- Typing-Indicator (3 springende Dots) während API-Call

---

## 10. Wochenplan-Architektur (WeeklyPlan.tsx)

### Wochenstart-Logik (ISO 8601)

Alle Wochengrenzen werden über `src/lib/dateUtils.ts` berechnet:
- **Woche beginnt Montag** (ISO 8601) — `getISOMonday(date)` liefert den Montag in Lokalzeit
- **Woche endet Sonntag** 23:59:59.999 — `getISOSunday(monday)` für Abfrage-Obergrenze
- **`week_start`-Schlüssel** (YYYY-MM-DD) wird via `getFullYear()/getMonth()/getDate()` aus Lokalzeit gebildet — nicht `toISOString()`, das UTC-Datum zurückgibt (Bug in CET/CEST)
- **Activity-Query** nutzt volle ISO-Timestamps: `gte('date', monday.toISOString())` und `lte('date', getISOSunday(monday).toISOString())` — damit fallen Sonntags-Aktivitäten korrekt in die Vorwoche
- **Plan-Lade-Query** nutzt `.in('week_start', [weekStr, weekStrFallback])` mit Fallback auf Vortag — defensiv für allfällige alte UTC-Einträge (kann nach 4 Wochen entfernt werden)

**Supabase-Migration (30.6.2026):** Alle `week_start`-Werte mit DOW=0 (Sonntag, falsch durch UTC-Bug) wurden um +1 Tag korrigiert:
`2026-06-21→06-22`, `2026-06-28→06-29`, `2026-07-05→07-06`

### Fallback: `closeOutstandingAnalyses()` (2. Juli 2026)

Sicherheitsnetz für den Fall, dass die fire-and-forget Hintergrund-Analyse aus `syncActivitiesToSupabase()` (siehe Kapitel 9 „Auto-Analyse") noch nicht fertig war oder für eine Aktivität fehlgeschlagen ist. Wird von **`generatePlan()` und `startReview()` jeweils als erstes im `try`-Block** aufgerufen — noch vor `buildCoachContext()` —, damit `[LETZTE AKTIVITÄTS-ANALYSE]` garantiert aktuell ist.

**Ablauf:**
1. `SELECT * FROM activities WHERE athlete_id = ... AND claude_analysis IS NULL AND date >= (heute − 7 Tage)`
2. Bei Treffern: `loadingMessage` wird gesetzt (`"Schließe {n} ausstehende Analyse(n) ab…"`) und im Generate-/Review-Button anstelle des generischen „Generiere Plan…"/„Review läuft…" angezeigt
3. **Claim vor Analyse (9. Juli 2026):** pro Aktivität erst `claimActivityForAnalysis(act.id)` (siehe Kapitel 9 „Auto-Analyse — Race-Fix") — schlägt der Claim fehl (bereits vom parallel laufenden Sweep aus `syncActivitiesToSupabase()` übernommen, das ein paar Zeilen zuvor selbst angestoßen wurde), wird die Aktivität mit `continue` übersprungen statt ein zweites Mal analysiert
4. Nur bei gewonnenem Claim: Aktivität wird mit `analyzeActivity()` nachanalysiert
5. Fehlgeschlagene Einzel-Analysen werden geloggt, blockieren aber weder die Schleife noch den nachfolgenden Plan-/Review-Call
6. Die gesamte Funktion ist in `try/catch/finally` gewrappt — ein Fehler bereits beim `SELECT` darf die eigentliche Plan-/Review-Generierung (das primäre Feature) nicht verhindern; `finally` setzt `loadingMessage` in jedem Fall zurück

---

### Plan-Generierung (`generatePlan()`)

**Inputs:**
- `closeOutstandingAnalyses()` (Fallback, siehe oben) → zuerst, awaited
- `buildCoachContext(athleteId)` + `coach_decisions[type=recovery_required, letzte 7 Tage]` → parallel
- `COACH_SYSTEM_PROMPT` → als `system`-Parameter
- Woche (Montag-Datum als Referenz)
- `athlete.training_days_per_week` und `athlete.sport_types`

**Prompt-Struktur:**
```
{context}                             ← enthält [LETZTE AKTIVITÄTS-ANALYSE] Block
---
Erstelle den Wochenplan für die Woche vom {monday} bis {sunday}.

HARTE REGELN (nicht verhandelbar):
1. Gesamttage: exakt {trainingDays} Trainingstage und {7 - trainingDays} Ruhetage (Mo–So = 7 Tage).
2. Sportarten-Verteilung:
   - Laufen: exakt 2 Tage
   - Radfahren: exakt 2 Tage
   - Krafttraining: exakt 1 Tag

AKTUELLE ERHOLUNGS-EINSCHRÄNKUNGEN (höchste Priorität — überschreiben alle anderen Regeln):
- {date}: {reasoning}                 ← aus coach_decisions, type='recovery_required'

SPORTWISSENSCHAFTLICHE REIHENFOLGE-REGELN:
3–6. Keine zwei intensiven Tage hintereinander; Kraft nie vor intensiver Ausdauer; etc.

KRAFTTRAINING-ROTATION:
7. Rotation IMMER Workout I → II → III → I
8. description-Feld bei Kraft: NUR "Workout I", "Workout II" oder "Workout III"
9. Kontext für letztes Kraft-Workout prüfen

SELF-CHECK VOR AUSGABE: ...

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt...
```

**Response:** Claude gibt `PlanJson` zurück  
**max_tokens:** 2048

---

### Constraint-Validierung (`validateConstraints()`)

```typescript
// Trainingstage: alle Tage die NICHT rest-keywords enthalten
const trainingCount = dayValues.filter(d =>
  !['ruhetag','erholung','regeneration'].some(k => d.type.toLowerCase().includes(k))
).length

// Pro Sportart: Keyword-Matching
const SPORT_KEYWORDS = {
  cycling:  ['ride', 'radfahren', 'cycling'],
  running:  ['run', 'laufen', 'running'],
  strength: ['kraft', 'weighttraining', 'krafttraining'],
}
```

**Fehlerfall:** Violations-Banner mit "Neu generieren" (nochmal API-Call) oder "Trotzdem speichern" (speichert mit `plan_constraint_violation: true`).

---

### Button-Sichtbarkeit — "Plan generieren" (nur aktuelle/zukünftige Wochen, seit 8. Juli 2026)

`isPastWeek = monday < getISOMonday(new Date())` (`WeeklyPlan.tsx`) — dasselbe Vergleichsmuster wie die Wochenreview-Sichtbarkeit weiter unten, nur mit `<` statt `<=`.

- `isPastWeek === true`: Button entfällt vollständig, unabhängig davon ob `plan` existiert.
  - Ohne Plan: neutraler Hinweistext „Für diese Woche wurde kein Plan erstellt".
  - Mit Plan: kein Hinweistext, keine Aktion — der Plan wird im Bereich darüber ohnehin normal angezeigt, "Plan neu generieren" ist für abgelaufene Wochen schlicht keine Option mehr.
- `isPastWeek === false` (aktuelle oder zukünftige Woche): Button wie zuvor, Label abhängig von `plan` ("Plan für diese Woche generieren" / "Plan neu generieren").

Betrifft ausschließlich das Erzeugen neuer Pläne — bestehende Pläne jeder Woche werden immer normal angezeigt, manuelle Bearbeitung (Drag&Drop, Kontextmenü) ist davon unberührt.

---

### Wochenreview (`startReview()` + `saveReviewData()`, entkoppelt von Plan-Generierung seit 6. Juli 2026)

**Wichtig:** `startReview()` und `generatePlan()` sind zwei vollständig unabhängige Aktionen. Ein Wochenreview erzeugt **ausschließlich** eine Bewertung der abgelaufenen Woche — es generiert nie mehr implizit einen neuen Plan für die Folgewoche. „Plan generieren" bleibt der einzige Weg, einen neuen Wochenplan zu erzeugen, unverändert an die im Navigator angezeigte Woche gebunden.

**Inputs:**
- `closeOutstandingAnalyses()` (Fallback, siehe oben) → zuerst, awaited
- `buildCoachContext(athleteId)` → vollständiger Coach-Kontext
- `weekActivities`: alle Aktivitäten der Woche aus `activities`
- `reviewFeedback`: Freitext-Input des Athleten
- Aktueller Wochenplan-Summary (optional, nur zur Einordnung „Geplant war: …")

**Review-Prompt enthält ausschließlich:**
- Absolvierte Aktivitäten der Woche (Name, Typ, Dauer, Distanz, Ø HF, NP)
- Freitext-Feedback
- Aufforderung zu einer reinen Wochenbewertung (3-4 Sätze)

Keine harten Regeln, Sportarten-Constraints, Trainingstage oder Kraft-Rotation mehr im Review-Prompt — das ist exklusiv Sache von `generatePlan()`.

**Claude-Output (JSON):**
```json
{ "review": "Wochenbewertung 3-4 Sätze, direkt und konkret" }
```

**max_tokens:** 600 (vorher 3000 — kein Plan-JSON mehr in der Antwort)

**`saveReviewData(reviewText: string)`:**
- Guard: existiert für die angezeigte Woche noch kein Plan (`plan?.plan_json` fehlt), wird das Review mit Fehlermeldung abgelehnt statt einen leeren Plan anzulegen (`weekly_plans.plan_json` ist `NOT NULL`)
- `select('version')` auf `weekly_plans` mit `week_start = weekStr` (die **bewertete** Woche W, nicht mehr die Folgewoche) → `nextVersion = max + 1`
- INSERT: `week_start = weekStr`, `plan_json = plan.plan_json` (unverändert vom Vorgänger übernommen — Review ändert den Plan-Inhalt nicht), `review_notes = reviewText`, `review_user_input = reviewFeedback.trim() || null`, `change_reason = 'Wochenreview durchgeführt'`
- INSERT in `coach_decisions`: `decision_type = 'weekly_review'`
- Setzt `plan` (React-State) auf den neu eingefügten Datensatz — WeeklyReviewCard erscheint sofort, ohne Reload

**`review_notes`/`review_user_input` Semantik (geändert):** Die Bewertung der Woche W liegt jetzt auf `weekly_plans` der Woche W **selbst** (nicht mehr auf W+1). `buildCoachContext()` liest `review_notes` weiterhin generisch (unverändert).

**Legacy-Daten (Reviews vor dem 6. Juli 2026):** liegen noch auf `week_start = W+1` und werden dort weiterhin als „diese Woche wurde reviewt" anzeigt — semantisch off-by-one (das Review galt eigentlich der Vorwoche), aber harmlos: keine Crashes, keine Schema-Änderung nötig. Bewusst als bekannte Alt-Daten-Inkonsistenz hingenommen, kein Migrations-Fallback geschrieben.

---

### Wochenreview-Ergebnis-Karte (`WeeklyReviewCard`, zuletzt vereinfacht 6. Juli 2026)

Aufklappbare Karte (Titel „Wochenreview" + Chevron, lokaler `expanded`-State, **immer** `true` bei Mount — kein persistierter Zustand, jedes Neuladen der Woche startet ausgeklappt, da die Komponente über `key={"week-"+weekStr}` bei Wochenwechsel neu gemountet wird). Inhalt: „Deine Notizen:" (nur gerendert wenn `userInput` vorhanden — Legacy-Reviews vor dem 6. Juli 2026 haben `review_user_input = null`) + „Coach-Bewertung:" (immer vorhanden).

**Einheitlicher Check (ersetzt die frühere Fall-A/Fall-B-Unterscheidung):** Trägt der geladene `plan`-Datensatz der angezeigten Woche `review_notes`, erscheint die Karte in der „Wochenreview"-Sektion **anstelle** des Eingabe-Formulars (Aktivitätsliste + Textarea + „Wochenreview starten"-Button). Kein separater `nextWeekPlan`-Query mehr nötig — seit der Entkopplung landet `review_notes` direkt auf der Woche, die bewertet wurde, also exakt der Woche, die gerade angezeigt wird.

---

### Week-Navigation
- Buttons ‹/› für ±1 Woche
- Wochenreview-Section nur sichtbar für aktuelle + vergangene Wochen

---

### Plan-Speicherung (`savePlanJson()`)
- `select('version')` → nextVersion = max(version) + 1
- INSERT in `weekly_plans`
- INSERT in `coach_decisions` mit `decision_type = 'plan_generated'`
- Niemals UPDATE

---

### Manuelles Verschieben von Trainingstagen (4. Juli 2026, Persistenz-/Trigger-Überarbeitung am selben Tag)

Der Athlet kann den geladenen Wochenplan direkt in `WeeklyPlan.tsx` per Drag-and-Drop (über einen dedizierten Griff) oder über ein Kontextmenü anpassen, ohne einen neuen Claude-Call auszulösen.

**`DayPlan`/`PlanJson`-Typen** (lokal in `WeeklyPlan.tsx` definiert, nicht Teil von `lib/supabase.ts`):
```typescript
type DayPlan = {
  type: string
  duration_min?: number
  distance_km?: number
  intensity?: string          // freier String, i.d.R. "Z1"–"Z5"; null bei Kraft/Ruhetag
  description: string
  _restoreFrom?: DayPlan      // nur bei manuell erzeugten Ruhetagen gesetzt, siehe unten
}
type PlanJson = { summary: string; days: Record<string, DayPlan> }
```

**`swapDays(planJson, dayA, dayB)`:** Tauscht die Inhalte zweier Tage; die Wochentags-Schlüssel (Mo–So) bleiben fix. Wird sowohl vom Drag-and-Drop-Drop-Handler als auch von „Verschieben nach..." genutzt (identische Logik).

**Drag-and-Drop:** `DndContext` + `SortableContext` (`@dnd-kit/core` + `@dnd-kit/sortable`) um die Liste der 7 `DayCard`s. `SortableDayCard` ist ein schlanker Wrapper, der nur `useSortable({id: day})` aufruft und `attributes`/`listeners` als `dragAttributes`/`dragListeners`-Props an `DayCard` durchreicht — die Liste selbst wird **nicht** neu sortiert (`items={DAYS}` ist konstant Mo–So); ein Drop von Tag A auf Tag B tauscht nur den Karteninhalt via `swapDays()`.

**Drag-Griff statt ganzer Karte:** `attributes`/`listeners` hängen ausschließlich am `IconGrip`-Button rechts im Card-Header, nicht mehr am gesamten `SortableDayCard`-Wrapper. Nur dieser Button trägt `touch-none`/`cursor-grab` — der Rest der Karte (inkl. Klick-Navigation zur Aktivität bei completed/extra) bleibt normal scrollbar und tappbar. Sensoren: `PointerSensor` mit `activationConstraint: { delay: 200, tolerance: 8 }` (200ms bewusstes Halten, max. 8px Bewegungstoleranz während der Wartezeit — **nicht** `distance`-basiert, da eine reine Distanzschwelle normales vertikales Scrollen auf Mobile fälschlich als Drag interpretierte) + `KeyboardSensor`. Drag-Optik: `opacity: isDragging ? 0.4 : 1`, `zIndex: isDragging ? 10 : undefined` (gleiches Muster wie Profile.tsx).

**Kontextmenü-Trigger — Long-Press (4. Juli 2026, zurückgerollt vom „•••"-Button):** Ein 500ms-Long-Press (8px Bewegungstoleranz) auf die Karte öffnet das Kontextmenü, kein Button mehr nötig. Eigene Pointer-Handler in `DayCard` (`onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel`/`onPointerLeave`) laufen auf dem Karten-Wrapper und sind komplett unabhängig vom Drag-Griff (der hat seine eigenen, separaten `dragAttributes`/`dragListeners` nur auf dem `IconGrip`-Button) — daher keine Kollision mit dem dnd-kit-Sensor. Bewegung über die 8px-Toleranz hinaus bricht den Timer ab (`clearPressTimer()`), damit normales Scrollen nicht fälschlich als Long-Press gewertet wird. Ein `longPressFired`-Ref unterdrückt die anschließende Klick-Navigation (`onClick`) auf completed/extra-Karten, falls der Long-Press ausgelöst hat. `onContextMenu` wird `preventDefault()`-t, damit mobile Browser nicht zusätzlich ihr natives Kontextmenü einblenden.

Bottom-Sheet (`fixed inset-0 bg-black/70 … items-end sm:items-center`, `bg-slate-800 rounded-2xl` — gleicher Stil wie das Mid-Week-Feedback-Modal) mit zwei Optionen (reduziert von drei — „Details anzeigen" entfernt, redundant da die Karte ohnehin sichtbar ist):
1. **Ruhetag-Eintrag, Beschriftung abhängig vom Tagesinhalt:**
   - Kein `_restoreFrom` am aktuellen `DayPlan` (normaler Trainingstag oder echter, vom Coach generierter Ruhetag) → **„Als Ruhetag markieren"** → `markAsRestDay(originalDayPlan)` ersetzt den Tag durch `{ type: 'Ruhetag', description: 'Manuell freigehalten', _restoreFrom: originalDayPlan }` — der ursprüngliche Taginhalt bleibt eingebettet erhalten statt verworfen zu werden.
   - Hat `_restoreFrom` (manuell erzeugter Ruhetag) → **„Aktivität wiederherstellen"** → `updated.days[day] = currentDayPlan._restoreFrom` setzt exakt den ursprünglichen Taginhalt zurück.
   - Ein „echter", vom Coach generierter Ruhetag (aus `generatePlan()`/Review, ohne `_restoreFrom`) zeigt entsprechend nie „Aktivität wiederherstellen" — da gibt es nichts wiederherzustellen.
   - `_restoreFrom` ist Teil von `plan_json` (JSONB) und braucht kein eigenes DB-Feld — übersteht Reload und Versionswechsel automatisch mit.
2. **„Verschieben nach..."** — Untermenü mit den anderen 6 Wochentagen, Auswahl ruft `swapDays()` auf (identisch zu Drag-and-Drop). Da `_restoreFrom` Teil des jeweiligen `DayPlan`-Objekts ist, wandert es beim Swap mit auf den neuen Wochentag.

**Konflikt-Prüfung `checkPlanConflicts(days)`** (reine Funktion, kein Claude-Call): „Intensiv" folgt denselben sportwissenschaftlichen Regeln wie der `generatePlan()`-Prompt (Regeln 3–4) — `intensity` matched `/^Z[3-5]/` **oder** der Tag ist Krafttraining. Zwei Prüfungen (erste zutreffende gewinnt, es wird immer nur eine Konflikt-Message zurückgegeben):
1. Krafttraining direkt vor einer intensiven Ausdauereinheit (spezifische Meldung)
2. Zwei intensive Tage direkt hintereinander (generische Meldung)

**Ablauf pro Änderung** (`applyManualEdit(updatedPlan, changeReason)` als zentraler Einstiegspunkt für Drag-Drop, „Verschieben nach...", „Als Ruhetag markieren" und „Aktivität wiederherstellen"):
- Änderung wird sofort in `manualPlanJson` (State-Layer über `plan.plan_json`) übernommen — Anzeige aktualisiert sich direkt
- `checkPlanConflicts()` läuft auf das Ergebnis
- **Kein Konflikt:** `commitManualChange(updatedPlan, changeReason, false)` wird direkt aufgerufen → speichert (siehe unten) → grüner Toast „Plan aktualisiert ✓" (`bg-brand-500`, 2,5s Autohide, gleicher Stil wie `feedbackToast` in ActivityDetail.tsx)
- **Konflikt:** `updatedPlan` wird zusätzlich in `pendingManualPlan` gemerkt, Amber-Banner mit Konflikt-Message + „Abbrechen" (macht die Änderung via `previousManualPlanJson`-Ref rückgängig, kein Speichern) / „Trotzdem speichern" (`commitManualChange(pendingManualPlan, pendingManualChangeReason, true)`)

**Bugfix Persistenz (4. Juli 2026) — Stale-Closure in `commitManualChange`:** Ursprünglich nahm `commitManualChange(changeReason)` nur den `changeReason` als Parameter entgegen und las den zu speichernden Plan aus dem `manualPlanJson`-State. Der No-Konflikt-Pfad rief `commitManualChange()` aber **synchron im selben Tick** wie `setManualPlanJson(updatedPlan)` auf — React-State-Updates wirken erst im nächsten Render, also las `commitManualChange` über die Closure des laufenden Renders noch den **alten** Wert. Folge: die allererste manuelle Änderung nach einem Seitenaufruf (`manualPlanJson` noch `null`) loggte gar keinen INSERT (stiller Totalverlust, kein Toast, kein Fehler — die Karte zeigte die Änderung trotzdem korrekt an, weil die Anzeige direkt aus dem State-Update kam); jede weitere Änderung speicherte die *vorherige* Änderung mit dem `change_reason`-Text der *neuen* Aktion (Plan-Inhalt und Change-Reason liefen dauerhaft einen Schritt auseinander). Der verzögerte „Trotzdem speichern"-Pfad war nicht betroffen, da dort genug Re-Renders zwischen `setManualPlanJson` und dem Button-Klick liegen.

Fix: **einheitliche Signatur** `commitManualChange(updatedPlan: PlanJson, changeReason: string, hasViolation: boolean)` — der zu speichernde Plan kommt in **jedem** Aufrufpfad explizit als Parameter herein, nie aus dem `manualPlanJson`-State gelesen. Der No-Konflikt-Pfad übergibt direkt das lokale `updatedPlan` aus `applyManualEdit()`; der Konflikt-Pfad übergibt das zusätzlich im neuen State `pendingManualPlan` gemerkte `updatedPlan` (gesetzt gemeinsam mit `pendingManualConflict`/`pendingManualChangeReason`). Beide Pfade rufen dieselbe Funktion mit demselben Parametermuster auf — kein Sonderfall, der sich erneut auseinanderentwickeln kann.

**Persistierung `saveManualPlanChange(updatedPlan, changeReason, hasViolation)`:** exakt dieselbe INSERT-only-Versionierung wie `savePlanJson()`/`saveReviewData()` — `select('version')` → `nextVersion = max + 1` → INSERT in `weekly_plans` mit `change_reason` (z. B. `"Manuell verschoben: Mo ↔ Mi"`, `"Mi als Ruhetag markiert"` oder `"Mi: Aktivität wiederhergestellt"`) und optional `plan_constraint_violation: true`. Zusätzlich INSERT in `coach_decisions` mit `decision_type = 'manual_plan_edit'` (neuer Wert, kein DB-Constraint verletzt — `decision_type` ist reines `TEXT`) — dadurch sieht der Coach bei der nächsten Plan-Generierung/-Review automatisch, dass der Athlet manuell eingegriffen hat (`buildCoachContext()` liest `coach_decisions` generisch, keine Änderung dort nötig). Fehler beim Speichern zeigen einen roten Toast „Speichern fehlgeschlagen. Bitte erneut versuchen." statt die Änderung zu verwerfen.

`manualPlanJson` (und `pendingManualPlan`/`pendingManualConflict`/`pendingManualChangeReason`) werden beim Wochenwechsel (neuer `weekStr`) zurückgesetzt, ebenso ein offener Konflikt-Banner.

**Aktivitäts-Matching bleibt korrekt:** `matchActivityToDay()` liest immer den aktuellen `dayPlan` aus `displayPlanJson.days[day]` pro Kalendertag — nach einer manuellen Änderung (Swap, Ruhetag oder Wiederherstellung) wertet die Matching-Logik automatisch die neue Zuordnung aus, ohne eigene Anpassung.

---

### Manuelles Vorziehen erkannter Aktivitäten (4. Juli 2026)

Erkennt, wenn eine Sportart bereits an einem früheren Tag durchgeführt wurde, obwohl sie eigentlich für einen anderen (noch ausstehenden) Wochentag geplant war — Beispiel: Krafttraining ist für Sonntag geplant, wurde aber schon am Samstag gemacht. Der Athlet kann das per Banner bestätigen, ohne den Plan inhaltlich zu ändern.

**1. Generalisierte `extraActivity`-Erkennung in `matchActivityToDay()`:** Bisher prüften nur Ruhetage auf eine zusätzliche Aktivität am selben Kalendertag (siehe Kapitel 9 „extra"). Jetzt gilt das für **jeden** Tag: unabhängig vom regulären Status (`completed`/`missed`/`pending`) wird geprüft, ob am selben Kalendertag eine weitere Aktivität liegt, deren `type` nicht zu den `SPORT_MATCH`-Typen des geplanten `dayPlan.type` passt — falls ja, landet sie in `DayMatch.extraActivity`. Ruhetage behalten ihr bestehendes `status: 'extra'`-Sonderverhalten unverändert (kein zusätzliches `extraActivity`-Feld dort, um die Bedeutung von Status `'extra'` nicht zu verwässern).

```typescript
type DayMatch = {
  status: 'completed' | 'missed' | 'pending' | 'extra'
  activity?: Activity
  extraActivity?: Activity   // nur bei Trainingstagen; zusätzliche Aktivität, deren Sportart nicht zum Plan passt
}
```

`DayCard` zeigt bei gesetztem `extraActivity` ein „+1"-Badge im Header sowie die Zeile „Außerdem: {activity.name}" — unabhängig vom Haupt-Status der Karte.

Ein zentrales `dayMatches`-Memo (`Record<string, DayMatch>`, ein `matchActivityToDay()`-Durchlauf pro Tag) ersetzt die vorher dreifach vorhandene Matching-Berechnung (Wochen-Kennzahlen, DayCard-Rendering, Vorziehen-Erkennung) — alle drei lesen jetzt aus derselben Quelle.

**2. Vorziehen-Erkennung `pickupSuggestion`:** Für jeden Tag `fromDay` mit `dayMatches[fromDay].extraActivity` wird geprüft, ob ein anderer Tag `toDay` in derselben Woche existiert, dessen `dayPlan.type` zur Sportart der `extraActivity` passt (`SPORT_MATCH`) **und** dessen Status noch `pending` ist (also noch bevorsteht oder heute ist — vergangene, nicht erfüllte Tage sind bereits `missed` und kommen dafür nicht in Frage). Der erste Treffer gewinnt.

**Hinweis-Banner** (dezent, neutral-blau, dismissable — unterhalb der Wochen-Kennzahlen, oberhalb der DayCards): „Du hast dein {Sportart} für {Wochentag} bereits heute/am {Wochentag} gemacht — als erfüllt markieren?" mit zwei Buttons:
- **„Verknüpfen"** → `handleConfirmPickup()`, siehe Punkt 3
- **„Nein danke"** → `handleDismissPickup()`, merkt sich `${stravaId}-${toDay}` in `dismissedPickupKey` (State), damit derselbe Vorschlag nicht sofort erneut erscheint. Wird beim Wochenwechsel (neuer `weekStr`) zurückgesetzt.

**3. Verknüpfung speichern — `DayPlan._fulfilledBy`:**

```typescript
type DayPlan = {
  // ...bestehende Felder
  _fulfilledBy?: { date: string; stravaId: number }   // Kalenderdatum + strava_id der vorgezogenen Aktivität
}
```

`handleConfirmPickup()` ändert den Zieltag (`toDay`) **inhaltlich nicht** (`type`/`description`/... bleiben unverändert) — es wird nur `_fulfilledBy` ergänzt und über denselben zentralen Weg wie Swap/Ruhetag persistiert: `applyManualEdit(updatedPlan, changeReason)` → `checkPlanConflicts()` → `commitManualChange()` → `saveManualPlanChange()` (INSERT-only, `version++`, `change_reason` z. B. `"Krafttraining von So auf Sa vorgezogen"`, automatischer `coach_decisions`-Eintrag `decision_type='manual_plan_edit'` — derselbe generische Mechanismus wie bei den übrigen manuellen Änderungen, keine Extra-Logik nötig). Da `_fulfilledBy` Teil von `plan_json` (JSONB) ist, übersteht es Reload und Versionswechsel automatisch mit, wie `_restoreFrom`.

**4. `matchActivityToDay()` berücksichtigt `_fulfilledBy`:** Ganz am Anfang der Funktion — noch vor der Ruhetag-Prüfung — gilt: ist `dayPlan._fulfilledBy` gesetzt, ist der Tag `completed`, unabhängig davon, was am eigentlichen Kalendertag selbst liegt. `activity` wird über dieselbe Activity-Lookup-Logik wie sonst aus der verknüpften `stravaId` aufgelöst (`activities.find(a => a.strava_id === dayPlan._fulfilledBy.stravaId)`).

`DayCard`-Anzeige: normales grünes ✓ wie bei jedem `completed`-Tag, zusätzlich eine Zeile „Vorgezogen am {Wochentag, Datum}" unter der Beschreibung (`formatFulfilledDate()` parst das gespeicherte `YYYY-MM-DD` explizit in Lokalzeit-Komponenten, nicht via `new Date(dateStr)`, das UTC-Mitternacht annehmen würde). Tap navigiert wie gewohnt über `match.activity.strava_id` zur echten (verknüpften) Aktivität.

**5. Verknüpfung aufhebbar:** Long-Press-Kontextmenü zeigt bei gesetztem `_fulfilledBy` einen zusätzlichen Eintrag „Verknüpfung aufheben" (`handleUnlinkFulfilled()`) — entfernt das Feld wieder (Objekt-Rest-Destrukturierung), persistiert über denselben `applyManualEdit()`-Weg (`change_reason`: `"{day}: Verknüpfung aufgehoben"`). Der Tag zeigt danach automatisch wieder seinen tatsächlichen Status (`pending`/`missed` je nach Kalenderdatum), da `matchActivityToDay()` dann wieder normal gegen den Kalendertag matcht.

**6. Wochenreview/-Kennzahlen zählen korrekt:** `weekStats.completedCount` liest bereits aus dem gemeinsamen `dayMatches`-Status — ein `_fulfilledBy`-Tag zählt dort automatisch als absolviert, keine Codeänderung nötig. Der Wochenreview-Prompt (`startReview()`) listet ohnehin die rohe Aktivitätsliste der Woche (`weekActivities`, unabhängig von der Tages-Zuordnung) sowie nur die freitextliche Plan-Summary — beides unberührt von `_fulfilledBy`. `coachContext.ts` (`buildCoachContext`, `planJsonWithDates`) reicht `plan_json` nur zur Anzeige/Datierung durch, ohne eigene Vollständigkeits-Zählung. Es existiert also keine separate, kalenderdatumsbasierte Zählung, die umgangen werden müsste.

---

### Mid-Week-Feedback — verschoben nach ActivityDetail.tsx (4. Juli 2026)

`WeeklyPlan.tsx` zeigt seit 4. Juli 2026 **keine** Feedback-Möglichkeit mehr (kein Feedback-Button an `DayCard`, kein Bottom-Sheet-Modal, keine `feedbackMap`-Ladelogik). Mid-Week-Feedback existiert jetzt ausschließlich in `ActivityDetail.tsx`, nebeneinander mit „Roast Me" — siehe Kapitel 9 „ActivityDetail.tsx — Mid-Week-Feedback". Der Feedback-Indikator auf den Dashboard-Aktivitätskarten ist in Kapitel 9 „Dashboard.tsx" dokumentiert.

---

## 11. Coach-Kontext-Architektur (`buildCoachContext`)

Funktion in `src/lib/coachContext.ts`. Signatur: `buildCoachContext(athleteId: string, threadId?: string, activeSport?: 'running' | 'cycling' | 'strength' | null)`. Wird bei JEDEM Claude-Call als User-Message-Inhalt aufgebaut.

**Alle 7 Hauptqueries laufen parallel (Promise.all).** Eine zusätzliche, davon abhängige Query löst für `[COACH-ENTSCHEIDUNGEN]` die Daten verknüpfter Aktivitäten auf (kann erst nach der `coach_decisions`-Query laufen, siehe unten).

```
[ATHLETEN-PROFIL]                      ~200 tokens
  Name, FTP, Max HF, Gewicht, Trainingstage, Sportarten, Ziele, Coach-Persona
  FTP nur wenn activeSport === 'cycling' oder activeSport ist undefined/null (kontextuelle
  Blindheit — bei 'running'/'strength' fehlt die FTP-Zeile komplett, nicht nur unerwähnt)
  Saison-Phase (Readaptation/Grundlage/Wettkampf/Taper) nur wenn activeSport !== 'strength'
  (kontextuelle Blindheit — bei 'strength' fehlt die Phase-Sektion komplett und wird durch
  einen Kraft-eigenen Trainingsziel-Block ersetzt, siehe Kapitel 12 und 18.4 Bugfix 3. Juli 2026)

[HARTE TRAININGS-CONSTRAINTS]          ~100 tokens
  Gesamte Trainingstage (von 7 Wochentagen), Ruhetage, Pflicht-Verteilung pro Sportart
  → "Diese Constraints sind nicht verhandelbar."

[SAISON-ZIELE]                         ~300 tokens
  Alle aktiven season_goals sortiert nach event_date
  Countdown zum nächsten A-Event in Tagen

[AKTUELLER WOCHENPLAN]                 ~400 tokens
  Neueste Version der laufenden Woche (week_start = Montag heute)
  + review_notes der Vorwoche (falls vorhanden)
  + plan_json als JSON — die Mo–So-Tageskürzel in `days` werden über `planJsonWithDates()`
    um das konkrete Kalenderdatum ergänzt (z. B. Schlüssel "Do 2.7.2026" statt nur "Do"),
    damit Claude die Wochentag↔Datum-Zuordnung nicht selbst berechnen muss (Fehlerquelle
    für falsche Datums-/Wochentagsnennungen in Empfehlungen, siehe Bugfix 2. Juli 2026)

[LETZTE AKTIVITÄTS-ANALYSE]            ~300 tokens  (nur wenn claude_analysis vorhanden)
  Neueste Aktivität mit claude_analysis aus activities
  Format: "{name} ({weekdayDateTime} — {relDay}, {type}):\n{claude_analysis}" — {weekdayDateTime}
  via `toLocalWeekdayDateTimeStr()` (Wochentag + Datum + Uhrzeit, z. B. "Mo 6.7.2026, 18:08 Uhr"),
  {relDay} via `relativeDayLabel()` ("heute"/"gestern"/"vor X Tagen"/"morgen"/"in X Tagen") —
  siehe Bugfix 8. Juli 2026
  → "Diese Analyse MUSS bei der Wochenplanung berücksichtigt werden."

[TRAININGSHISTORIE — LETZTE 4 WOCHEN]  ~600 tokens
  Aggregiert aus activities: Anzahl, km, Stunden, TSS, Ø HF, NP max — pro Woche

[PLAN-HISTORY — LETZTE 3 VERSIONEN]   ~300 tokens
  week_start, version, change_reason, plan summary
  + review_notes Snippet (max 250 Zeichen)

[COACH-ENTSCHEIDUNGEN — LETZTE 5]     ~300 tokens
  decision_type, decision_summary, reasoning, created_at, related_activity_id
  Bei gesetztem related_activity_id wird das Aktivitätsdatum separat aufgelöst (activities.name
  + activities.date, lokal formatiert via `toLocalWeekdayDateStr()`) und getrennt von
  `created_at` ausgewiesen — Format: "[{decision_type} zu {activity_name}, {Wochentag
  TT.MM.JJJJ} — eingegeben am {TT.MM.JJJJ}]: {decision_summary}". Ohne related_activity_id:
  "[{decision_type}] {TT.MM.JJJJ}: {decision_summary}" (created_at, lokal formatiert).
  Grund: `created_at` ist der Logging-/Eingabe-Zeitpunkt (z. B. beim Mid-Week-Feedback oft
  erst am Folgetag erfasst), nicht das Datum der Aktivität selbst — Claude hat beide vor dem
  Bugfix vom 2. Juli 2026 verwechselt (siehe unten).

[AKTUELLE CHAT-SESSION]                ~500 tokens  (nur wenn threadId übergeben)
  Letzte 10 Messages des threadId, chronologisch
```

### Bugfix 2. Juli 2026 — Datumsfehler in Coach-Analysen

**Symptom:** Ein Lauf vom Di 30.6. wurde in der Analyse eines späteren Laufs als "1.7." referenziert; eine "nächster Lauf"-Empfehlung nannte "Do, 3.7." (3.7.2026 ist tatsächlich ein Freitag).

**Root Causes (zwei unabhängige Fehlerquellen, kein Timezone-Bug bei `activities.date` selbst — `start_date` (UTC) wird korrekt gespeichert und von `toLocaleDateString()`/`toLocalDateStr()` korrekt lokal aufgelöst):**
1. `[COACH-ENTSCHEIDUNGEN]` zeigte bei `midweek_feedback`-Einträgen `created_at` (Zeitpunkt der Feedback-Eingabe im Wochenplan) als vermeintliches Ereignisdatum — wurde vom Coach mit dem tatsächlichen Aktivitätsdatum verwechselt, wenn Feedback erst am Folgetag eingegeben wurde.
2. `[AKTUELLER WOCHENPLAN]` gab Claude nur Wochentags-Kürzel (Mo–So) ohne Kalenderdatum mit — die Zuordnung musste Claude selbst berechnen und hat sich dabei verrechnet.

**Fix:** `[COACH-ENTSCHEIDUNGEN]` löst jetzt zusätzlich das Datum der `related_activity_id` auf und weist es getrennt von `created_at` aus (siehe Format oben). `[AKTUELLER WOCHENPLAN]` bekommt über `planJsonWithDates()` das Kalenderdatum direkt in die Tages-Schlüssel eingebettet. `[LETZTE AKTIVITÄTS-ANALYSE]` nutzt zusätzlich `toLocalDateStr()` statt `date.slice(0, 10)` (war bislang unauffällig, da kein Testfall die lokale Mitternachtsgrenze kreuzte, aber derselbe Bug-Typ wie der bereits behobene Wochengrenzen-Bug). Neue Helper `toLocalDateStr()` / `toLocalWeekdayDateStr()` in `dateUtils.ts`.

### Bugfix 8. Juli 2026 — erfundene Tageszeit in Coach-Analysen

**Symptom:** Die Analyse eines Abendlaufs (Di 7.7.2026, 18:30) behauptete, er sei "nach einem Krafttraining am Morgen" erfolgt. Das tatsächliche Krafttraining fand am Vorabend statt (Mo 6.7.2026, 18:08 — nicht morgens, nicht am selben Tag).

**Root Cause:** Kein Timezone-/Datenbug — `activities.date` war korrekt und wurde korrekt lokal aufgelöst (Mo 6.7. 18:08 / Di 7.7. 18:30, beides Abend). Weder der `activityBlock` der gerade analysierten Aktivität (`activityAnalysis.ts`) noch `[LETZTE AKTIVITÄTS-ANALYSE]` gaben je eine Uhrzeit, einen Wochentag oder eine explizite Tag-Relation mit — nur ein rohes `TT.MM.JJJJ`-Datum (`toLocalDateStr()`). Claude musste die Tagesdifferenz zwischen den beiden Daten selbst berechnen und hat dabei sowohl den Tag (Vortag → "heute") als auch die Tageszeit (Abend → "Morgen") frei erfunden, statt sie aus echten Daten abzuleiten.

**Fix:**
- Neue Helper in `dateUtils.ts`: `toLocalWeekdayDateTimeStr()` (baut auf `toLocalWeekdayDateStr()` auf, hängt manuell formatierte Uhrzeit an — bewusst kein `toLocaleDateString()`/`toLocaleTimeString()`, um beim bestehenden Lokalzeit-sicheren Stil ohne Intl-Abhängigkeit zu bleiben) und `relativeDayLabel()` (liefert "heute"/"gestern"/"vor X Tagen"/"morgen"/"in X Tagen").
- `[LETZTE AKTIVITÄTS-ANALYSE]` (`coachContext.ts`) nutzt jetzt `toLocalWeekdayDateTimeStr()` + `relativeDayLabel()` statt nur `toLocalDateStr()` (siehe Format oben).
- `activityBlock` (`activityAnalysis.ts`, `analyzeActivity()`) — die Datumszeile der gerade analysierten Aktivität selbst — nutzt dieselben zwei Helper statt `new Date(activity.date).toLocaleDateString('de-DE')`: `Datum: {weekdayDateTime} ({relDay})`.
- `buildCoachSystemPrompt()` (`coachPrompt.ts`, Abschnitt `## DATENNUTZUNG`) bekommt eine explizite Anti-Halluzinations-Regel: Claude darf nur explizit angegebene Datums-/Uhrzeit-/Tag-Relations-Angaben nutzen und keine Tageszeit oder relativen Tag selbst aus Datumsdifferenzen berechnen/erfinden.
- `[AKTUELLER WOCHENPLAN]` (`planJsonWithDates()`) und `[COACH-ENTSCHEIDUNGEN]` (`toLocalWeekdayDateStr()`) bleiben unverändert — beide hatten bereits Wochentag bzw. Kalenderdatum, nur `[LETZTE AKTIVITÄTS-ANALYSE]` und der `activityBlock` fehlten Uhrzeit/Tag-Relation.

**Ziel: unter ~3.000 tokens, immer gleiche Struktur.**

Nur `ActivityDetail.tsx` (`runAnalysis()`) reicht `activeSport` durch; Chat/WeeklyPlan rufen weiterhin ohne dritten Parameter auf (kein einzelner Sport-Fokus, FTP bleibt sichtbar).

### `buildSpecialistContext(athleteId, sport)`

Ergänzende Funktion, die sportart-spezifische Historien-Daten liefert. Wird parallel zu `buildCoachContext()` geladen und als zweiter Block in die User-Message eingefügt.

```
sport = 'running':
  Letzte 10 Run/VirtualRun/TrailRun Aktivitäten (60 Tage)
  Datum | km | Pace (min/km) | Ø HF

sport = 'cycling':
  FTP aus athletes-Tabelle
  Letzte 10 Ride/VirtualRide/MountainBikeRide/GravelRide (60 Tage)
  Datum | km | NP (W + % FTP) | TSS | Ø HF

sport = 'strength':
  Equipment aus athletes.equipment (aktive Geräte)
  Ästhetik-Prioritäten aus athletes.aesthetic_goals (nur wenn "Muskelaufbau" oder "Gewicht reduzieren" in body_goals)
  Letzte 5 WeightTraining/Workout Aktivitäten (60 Tage)
  Datum | Name | Description-Snippet (max 200 Zeichen)
```

---

## 12. Coach-Prompts (`coachPrompt.ts`)

Siehe Kapitel 18 für Details zur Coach-Architektur.

**Implementierter Stand:**

**`buildCoachSystemPrompt(athleteId, activeSport?: 'running' | 'cycling' | 'strength' | null)`** (Hauptcoach — async, dynamisch):
- Lädt bei jedem Aufruf Athleten-Profil + A-Event aus Supabase (inkl. `gender`, `birth_year`, `resting_hr`)
- Dynamische Abschnitte: Name, Geschlecht, Alter, Gewicht, Leistungsgewicht (W/kg), FTP, Max HF (gemessen od. geschätzt: Tanaka-Formel 208−0.7×Alter), Ruhe-HF, HF-Reserve (Karvonen), Sportarten, Equipment, Ästhetik-Ziele, Coach-Stil/Fokus, Saisonziel, Wochen-Countdown, aktuelle Phase, HF-Zonen, Pace-Referenz
- **`activeSport`-Parameter (kontextuelle Blindheit auf Kontext-Ebene):** Leistungsgewicht (W/kg) und FTP werden NUR in den `[ATHLETEN-PROFIL]`-Block aufgenommen wenn `activeSport === 'cycling'` oder `activeSport` ist `undefined`/`null` (kein Sport-Fokus — Chat, Wochenplan, Dashboard). Bei `activeSport === 'running'` oder `'strength'` fehlen FTP/W-kg vollständig im Kontext — nicht nur als Anweisung "nicht erwähnen", sondern schlicht nicht vorhanden.
- **Analoges Gating für die Saison-Phase (`showSeasonPhase`):** Die Lauf-Saisonphase (Readaptation/Grundlage/Wettkampf/Taper, aus `calculateSeasonPhase()`) wird NUR eingefügt wenn `activeSport !== 'strength'` — also bei `'running'`, `'cycling'` und ohne Sport-Fokus (Chat/Wochenplan/Dashboard) bleibt sie sichtbar, da Rad-Training in Phase 1–2 die Laufbasis unterstützt (Coaching-Prinzip 7). Bei `activeSport === 'strength'` fehlt die Phase-Sektion komplett und wird durch `strengthGoalSection` (`## TRAININGSZIEL KRAFTTRAINING` — Körperziele + Ästhetik-Prioritäten) ersetzt. Grund: Krafttraining folgt einem eigenständigen Ästhetik-/Hypertrophie-Ziel, keiner Lauf-Periodisierung; die Phase-Labels sind wörtlich lauf-spezifisch formuliert und wurden vom Coach sonst fälschlich auf Krafttraining-Analysen übertragen (Bugfix 3. Juli 2026, siehe Kapitel 18.4).
- Statische Abschnitte: Coaching-Prinzipien (8 Regeln), Datennutzung, Review-Format, Antwortformat (inkl. Du-Form-Pflicht: niemals über den Athleten in der dritten Person)
- Hilfsfunktionen in `coachContext.ts` (exportiert):
  - `calculateSeasonPhase(weeksUntilEvent, override)` — Phase aus Wochen-Countdown oder manuellem Override
  - `calculateHRZones(maxHR, restingHR?)` — Z1–Z5: Karvonen-Methode wenn `restingHR` vorhanden, sonst %-Methode als Fallback
  - `calculateZ2HRRange(maxHR, restingHR?)` — numerische Z2-HF-Grenzen (`{min, max}`), von `calculateHRZones()` intern genutzt und zusätzlich für `calculateDynamicZ2Pace()` exportiert
  - `calculateDynamicZ2Pace(runningActivities, hrZoneMin, hrZoneMax)` — distanzgewichtete Ist-Pace aus echten Läufen mit HF in der Z2-Range (letzte 8 qualifizierende, Mindestschwelle 3), sonst `null`
  - `calculatePaceReference(best5kSeconds, targetEventKm, dynamicZ2?)` — Zielpace/Schwellenpace immer aus 5k-PB; Z2-Trainingspace aus `dynamicZ2` (echte Läufe) wenn vorhanden, sonst Formel-Fallback aus 5k-PB (5. Juli 2026)
- Wird bei JEDEM Claude-Call als `system`-Parameter übergeben (alle 4 Consumer: ActivityDetail, Chat, WeeklyPlan, Dashboard). Nur `ActivityDetail.tsx` (`runAnalysis()`) reicht `activeSport` durch (aus `getSpecialistPrompt(activityType)`-Routing); Chat/WeeklyPlan/Dashboard rufen weiterhin ohne zweiten Parameter auf, da dort kein einzelner Sport-Fokus besteht.

**`COACH_STYLE_PROMPTS`** (5. Juli 2026 — 3 Stile, vormals 4 mit „Direkt"/„Empathisch"):
- `Record<string, string>`, keyed nach dem in `athletes.coach_persona.style` persistierten Key (`motivierend` | `analytisch` | `drill_sergeant` — lowercase, identisch zu den Keys in `PERSONA_STYLES` in Profile.tsx/Onboarding.tsx), nicht nach dem Anzeige-Label
- Jeder Eintrag enthält detaillierte Ton-Anweisungen (nicht nur ein Label) — wird in `buildCoachSystemPrompt()` als eigener `## COACH-STIL`-Abschnitt vor `## ANTWORTFORMAT` eingefügt: `COACH_STYLE_PROMPTS[athlete.coach_persona?.style ?? DEFAULT_STYLE] ?? COACH_STYLE_PROMPTS[DEFAULT_STYLE]` (Fallback greift auch für Alt-Werte `direkt`/`empathisch` aus vor dem 5. Juli 2026 angelegten Profilen — kein hartes DB-Update nötig)
- `DEFAULT_STYLE = 'analytisch'`
- `STYLE_LABELS: Record<string, string>` (separat exportiert) mappt Key → Anzeige-Label (`drill_sergeant` → „Drill Sergeant"), genutzt für die informative `Coach-Stil: …`-Zeile im `[DEIN ATHLET]`-Block sowie für Subtitle-Anzeigen in Profile.tsx/Onboarding.tsx (ersetzt eine vorherige naive `charAt(0).toUpperCase()`/CSS-`capitalize`-Logik, die bei einem mehrwortigen Key wie „Drill Sergeant" gebrochen hätte)
- `Drill Sergeant`: harter, befehlsartiger Ton mit fester Grenze — greift nie die Person selbst an, Sicherheitsempfehlungen bleiben unverändert korrekt, weicht bei gemeldeten Schmerzen/Verletzung sofort einem ernsten, klaren Ton

**`LAUF_COACH_PROMPT`** / **`RAD_COACH_PROMPT`** / **`KRAFT_COACH_PROMPT`** (Spezialcoaches — statisch):
- Sportart-spezifisch, nicht athleten-spezifisch → bleiben statische Exports
- Werden auf `buildCoachSystemPrompt()` aufgesattelt (`basePrompt + '\n\n' + SPECIALIST_PROMPT`)
- Routing über `getSpecialistPrompt(activityType)` in `ActivityDetail.tsx`
- Lauf: Zonen-Audit, Pace-Konsistenz, HF-Drift, Verletzungssignale
- Rad: Power-Zonen (FTP-basiert), NP/VI-Analyse, TSS/IF-Einordnung
- Kraft: Hevy-Volumen-Analyse, Schulter-Check, Laufsynergie, Equipment- + Ästhetik-Kontext, explizite Blindheit gegenüber Lauf-Periodisierungsbegriffen ("Readaptation", "Laufeinstieg", "Phase X" etc. — siehe Kapitel 18.4 Bugfix 3. Juli 2026)

---

## 13. Architektur-Invarianten (tatsächlich eingehalten)

1. **Supabase ist Source of Truth** — kein Plan, keine Entscheidung, keine Chat-Message lebt nur im React-State
2. **Claude-Antworten werden sofort in Supabase gespeichert** bevor sie im UI erscheinen (Chat, ActivityDetail, WeeklyPlan)
3. **weekly_plans: INSERT-only** — niemals UPDATE; neue Version = neuer Row
4. **buildCoachContext() ohne rohe Stream-Daten** — nur aggregierte Wochenwerte aus activities
5. **Kein direkter Claude-Call vom Browser** — ausschließlich über `/api/analyse`
6. **Kein Strava Client Secret im Browser** — ausschließlich über `/api/strava-token`
7. **Auto-Save mit 800ms Debounce** in Profile.tsx (kein manueller Save-Button)
8. **Cache-first für Streams und Descriptions** — Supabase zuerst, Strava-API nur bei null

---

## 14. Lokale Entwicklung

```bash
npm run dev     # Vite Dev-Server auf localhost:5173
                # /api/analyse und /api/strava-token als Vite-Middleware (kein Vercel CLI nötig)
```

**Env-Variablen lokal:** Alle in `.env` (gitignored), Vite liest sie via `loadEnv()` auch für die Middleware.

---

## 15. PWA-Konfiguration

- `theme_color`: `#1D9E75` (brand-500)
- `background_color`: `#0f172a` (slate-900)
- `display`: `standalone`
- `registerType`: `autoUpdate`
- SW Cache-Header in `vercel.json`: `Cache-Control: no-cache`

---

## 16. Implementierungsstand

### Umgesetzt ✅

**Foundation:**
- React + Vite + Tailwind + TypeScript
- PWA (vite-plugin-pwa, theme_color #1D9E75)
- Vercel Hosting + Auto-Deploy auf main
- Supabase Schema (6 Tabellen)
- Strava OAuth 2.0 (Code-Exchange + Auto-Refresh)

**Onboarding:**
- `athletes.onboarding_completed BOOLEAN DEFAULT false` — neues Feld (Migration angewendet, Bestandsuser auf `true` migriert)
- Verpflichtender 6-Schritte-Wizard (`Onboarding.tsx`) — Name, Sportarten+Trainingstage, erstes Saisonziel, optionale Leistungsdaten, Coach-Stil, Zusammenfassung
- App.tsx Layout-Guard: `onboarding_completed = false` → Redirect zu `/onboarding`, unabhängig von der angeforderten Route
- Kein Skip möglich; `/onboarding` nicht über BottomNav erreichbar, kein AppHeader/Logout

**Navigation & Icons:**
- Bottom-Navigation (5 Tabs: Home / Plan / Coach / Ziele / Profil) — fix positioniert, außer auf /, /auth/callback und /onboarding
- AppHeader (Logo links, h-14, frosted-glass) — Logo ist `Link` zu `/dashboard` (cursor-pointer); `rightAction?: React.ReactNode` Slot rechts; jede Page rendert ihn selbst
- FA6 Icon-System (react-icons/fa6): alle Lucide/Emoji-Icons ersetzt
- SPORT_DISPLAY Konstante in icons.ts (cycling/running/strength/rest/other → Farbe + Label)
- **`other`-Fallback (4. Juli 2026):** `SPORT_DISPLAY` wird im Code nirgends dynamisch indiziert (`SPORT_DISPLAY[sport]`) — alle Zugriffe sind statische Literal-Keys, TypeScript verhindert einen ungültigen Key ohnehin. Die eigentliche "unbekannte Sportart"-Behandlung liegt in zwei separaten Icon-Mapping-Funktionen mit hartcodiertem Fallback: `ActivityIcon()` in Dashboard.tsx und `TypeIcon()` in WeeklyPlan.tsx — beide nutzten zuvor fälschlich das graue Lauf-Icon als generischen Fallback, jetzt `IconOther` (`FaStopwatch`) + `SPORT_DISPLAY.other.color` (neutrales Grau). `ActivityDetail.tsx` rendert kein Sport-Icon und ist nicht betroffen. `sportFromActivityType()` (ActivityDetail.tsx) und `getSpecialistPrompt()` (activityAnalysis.ts) bleiben bewusst bei `null` für unbekannte Strava-Typen statt `'other'` — ihr `null` wird in `coachContext.ts`/`coachPrompt.ts` als "zeige alles" ausgewertet (`showCyclingPower = activeSport === 'cycling' || activeSport == null`); ein `'other'`-Rückgabewert hätte FTP/W-kg-Anzeige für z.B. Schwimmen/Yoga fälschlich unterdrückt.
- page-content CSS-Klasse (padding-top: 72px + padding-bottom: 80px) auf allen Hauptseiten außer Chat

**Branding / Assets:**
- Favicon-Set in public/: favicon-16.png, favicon-32.png, apple-touch-icon.png (180×180), icon-192.png, icon-512.png
- PWA Manifest Icons: apple-touch-icon.png (180×180), icon-192.png (standard + maskable), icon-512.png
- Logo: public/peakform-logo.png (1x) + peakform-logo@2x.png (Retina) — im AppHeader + Splash + Home.tsx
- Home-Hintergrund: keiner — Home.tsx nutzt bg-slate-900 (splash-bg.jpg entfernt)
- Splash-Screen: App.tsx zeigt splash.png zentriert (80% Breite, max-w-sm) NUR wenn eingeloggt; bg-slate-900; CSS peakform-pulse; kein Logo; 2000ms + 400ms Fade-out
- Seitenüberschriften entfernt: Dashboard, Chat, Goals, Profile, WeeklyPlan — AppHeader ersetzt sie

**AppHeader rightAction-Slots:**
- Dashboard: Logout-Icon (`IconLogout size=18`, `p-2`)
- Goals: "+" Icon (`IconAdd size=18`, `p-2`)
- Chat: "Neu"-Button (Pill-Style, `rounded-full border border-slate-700`, Icon + Text)
- WeeklyPlan / Profile / ActivityDetail: kein rightAction

**Dashboard & Aktivitäten:**
- Letzte 10 Aktivitäten von Strava, gecacht in Supabase
- Nav-Kacheln entfernt (durch BottomNav ersetzt)
- Aktivitäten-Filter nach Typ (Rad/Lauf/Kraft) mit FA6-Icons — rein clientseitig auf dem geladenen Array
- Logout
- `syncActivitiesToSupabase()`: Upsert lässt `claude_analysis` beim Update unangetastet + stößt fire-and-forget Auto-Analyse aller Aktivitäten mit `claude_analysis IS NULL` an (2. Juli 2026, siehe Kapitel 9)
- **Pagination „Mehr laden"** (4. Juli 2026): paginiert gegen die Strava API (`page`-Parameter in `fetchRecentActivities()`), nicht gegen Supabase — siehe Kapitel 9 „Dashboard.tsx — Pagination"

**ActivityDetail:**
- **Sportartabhängige Darstellung** (Lauf vs. Rad vs. Kraft)
- Lauf: Pace statt km/h, kein NP, kein Höhenmeter, kein Watt-Chart, kein Pace-Chart
- Lauf: Kilometer-Splits-Tabelle (KM | ZEIT | PACE | Ø HF); Datenquelle: `splits_metric_json` (Strava `GET /activities/{id}` → `splits_metric`), Cache-first in Supabase
- Rad: Watt-Chart, HF-Chart, Höhenprofil, Rundentabelle unverändert
- Cache-first für streams_json, laps_json und description
- Hevy-Workout-Parser (aus Strava description)
- Übungskarten mit Muskelgruppe-Pill und Volumen-Pill
- Claude-Analyse (gespeichert in activities.claude_analysis) — Analyse-Logik ausgelagert in `src/lib/activityAnalysis.ts` (`analyzeActivity()`), von Button, Sync-Hintergrundjob und Plan/Review-Fallback gemeinsam genutzt (2. Juli 2026)
- Analyse läuft automatisch im Hintergrund nach dem Sync; Button heißt durchgängig „Neu analysieren"; Polling (3s-Intervall, max. 10 Versuche) zeigt „Analyse läuft im Hintergrund…" solange keine Analyse vorliegt (2. Juli 2026)
- Markdown-Renderer (h1-h3, Bullets, Blockquotes, bold)

**Profil:**
- Alle 6 Sektionen als einklappbares Akkordeon (`AccordionSection`-Komponente)
- Reihenfolge: ALLGEMEIN → TRAINING → LEISTUNGSDATEN → ZIEL & COACH → TRAININGSPHASE → KRAFTTRAINING
- ALLGEMEIN + TRAINING standardmäßig aufgeklappt; Rest eingeklappt
- KRAFTTRAINING nur sichtbar wenn `strength` in sport_types; klappt automatisch auf wenn Krafttraining neu aktiviert
- Subtitles zeigen Preview-Inhalt wenn Sektion eingeklappt
- Status-Indikator (Speichert… / ✓ Gespeichert) fixed top-right
- Smooth scrollIntoView beim Aufklappen auf kleinen Screens
- Touch-Targets ≥ 48px (`min-h-[3rem]`)
- 800ms Auto-Save für alle Felder inkl. equipment, aesthetic_goals, season_phase_override
- Self-Service Konto-Löschung: rot abgesetzte Sektion unterhalb des Akkordeons, Bottom-Sheet-Modal mit Zwei-Stufen-Bestätigung, `deauthorizeStrava()` vor `delete_athlete_account()`-RPC, Fehler-/Warnungs-Zustände im Modal, Erfolg → Logout-Cleanup + Redirect (siehe Kapitel 9 „Profile.tsx — Konto löschen" und Kapitel 18)

**Saison-Ziele:**
- A/B/C-Priorität
- Countdown in Tagen (für A-Event prominent)
- Add/Edit-Modal
- Deaktivieren (active = false, kein DELETE)

**Wochenplan:**
- Plan-Generierung mit harten Constraints + sportwissenschaftlichen Regeln
- Krafttraining-Rotation Workout I/II/III
- Frontend-Constraint-Validierung + Violation-Banner ("Neu generieren" / "Trotzdem speichern")
- INSERT-only mit version++
- Wochen-Navigation (±1 Woche)
- Wochenreview mit Aktivitäts-Summary + Freitext-Feedback
- Folgeplan-Generierung aus Review (mit gleichen Constraint-Checks)
- Review-Violations werden dem User angezeigt (nicht still gespeichert)
- review_notes in coach context für Plan-Generierung der nächsten Woche
- coach_decisions Logging
- **Aktivitäts-Matching:** DayCards zeigen Status completed (grün) / missed (amber) / extra (blau) / pending (neutral)
  - `matchActivityToDay()`: Typ-Matching Laufen→Run/VirtualRun/TrailRun, Radfahren→Ride/..., Kraft→WeightTraining/Workout
  - completed: grüner linker Rand + ✓ Icon + Aktivitätsname + Dauer; Tap → `/activity/{strava_id}` (**nicht** `activity.id`/Supabase-UUID — `ActivityDetail.tsx` lädt via `.eq('strava_id', Number(id))`, siehe Kapitel 9 „Identifier-Konvention Aktivitäts-Navigation")
  - missed: amber linker Rand + ✗ Icon + "Nicht absolviert" (nur vergangene Tage)
  - pending: neutrales Erscheinungsbild
  - **extra** (4. Juli 2026): Ruhetage (`type` matcht `REST_KEYWORDS`) prüfen zusätzlich, ob trotzdem eine Aktivität auf dieses Datum fällt (unabhängig von Sportart-Matching, jeder `activity.type`) — falls ja: Status `extra` statt `pending`. Bewusst **kein** `completed` (ein Ruhetag wird nicht "geschafft", sondern durchbrochen): blauer linker Rand + "Extra"-Pill statt ✓/✗ + Zeile "Zusätzlich trainiert: {activity.name}"; Tap navigiert wie bei completed zu `/activity/{strava_id}`
  - **extraActivity** (4. Juli 2026, generalisiert): dieselbe Zusatz-Erkennung gibt es jetzt auch für **Trainingstage** — unabhängig vom regulären Status (`completed`/`missed`/`pending`) wird eine weitere Aktivität am selben Kalendertag mit abweichender Sportart als `DayMatch.extraActivity` mitgegeben (Ruhetage bleiben beim bestehenden `extra`-Sonderverhalten, kein zusätzliches `extraActivity`-Feld dort); `DayCard` zeigt dafür ein „+1"-Badge im Header + Zeile „Außerdem: {name}", zusätzlich zum normalen ✓/✗-Status; Details und die darauf aufbauende Vorziehen-Erkennung siehe Kapitel 10 „Manuelles Vorziehen erkannter Aktivitäten"
  - Mini-Sync: beim Laden des Wochenplans werden zuerst die letzten 10 Strava-Aktivitäten via `syncActivitiesToSupabase()` in Supabase gesynct (silent, non-blocking bei Fehler) — stößt dabei automatisch auch die Hintergrund-Analyse unanalysierter Aktivitäten an (siehe Kapitel 9 „Auto-Analyse")
- **Mid-Week Check-in:** Feedback-Button an completed DayCards, Modal, `coach_decisions` Insert/Update (`decision_type = 'midweek_feedback'`), Toast, kein zusätzlicher Claude-Call — siehe Kapitel 10
- **Manuelles Verschieben von Trainingstagen** (4. Juli 2026, Persistenz-/Trigger-Überarbeitung am selben Tag): Drag-and-Drop-Tausch zweier Tage über dedizierten Griff-Button (`@dnd-kit`, `swapDays()`) + Kontextmenü über 500ms-Long-Press auf die Karte (Ruhetag markieren/wiederherstellen via `_restoreFrom` / Verschieben nach...) + client-seitige Konflikt-Prüfung `checkPlanConflicts()` (kein Claude-Call) mit Amber-Banner bei Konflikt bzw. direktem Speichern+Toast ohne Konflikt; Persistierung INSERT-only (`saveManualPlanChange()`) inkl. `coach_decisions`-Eintrag `decision_type='manual_plan_edit'`; `PointerSensor` nutzt `{delay: 200, tolerance: 8}` statt `distance`-Schwelle, damit Scrollen auf Mobile nicht als Drag erkannt wird; `commitManualChange(updatedPlan, changeReason, hasViolation)` nimmt den zu speichernden Plan in jedem Aufrufpfad explizit als Parameter entgegen (Fix eines Stale-Closure-Bugs, der den No-Konflikt-Speicherpfad stumm scheitern ließ) — siehe Kapitel 10 „Manuelles Verschieben von Trainingstagen"
- **Manuelles Vorziehen erkannter Aktivitäten** (4. Juli 2026): erkennt automatisch, wenn eine bereits durchgeführte `extraActivity` zur noch ausstehenden Sportart eines anderen Wochentags passt, und bietet die Verknüpfung per dismissable Banner an (`_fulfilledBy`) — siehe Kapitel 10 „Manuelles Vorziehen erkannter Aktivitäten"
- **Fallback `closeOutstandingAnalyses()`** (2. Juli 2026): `generatePlan()` und `startReview()` holen unanalysierte Aktivitäten der letzten 7 Tage synchron nach, bevor der Plan-/Review-Call startet — Sicherheitsnetz falls die Hintergrund-Analyse aus dem Sync noch nicht fertig war; `loadingMessage` zeigt währenddessen „Schließe X ausstehende Analyse(n) ab…" im Button — siehe Kapitel 10
- **Wochen-Kennzahlen-Leiste** (3. Juli 2026, überarbeitet am selben Tag — Einheiten-Zeile entfernt, Werte vergrößert): Card zwischen Phasen-Banner (`displayPlanJson.summary`) und DayCards — eine Zeile mit drei Werten (`text-base`, Icons `size={20}`) mit `SPORT_DISPLAY`-Icons/-Farben: Lauf-km + Rad-km (Summe `distance_m` über `weekActivities` gefiltert nach `SPORT_MATCH.running`/`.radfahren`-Typen), Kraft-Gesamtgewicht (Summe `parseHevyDescription(a.description).totalVolume` über alle `WeightTraining`/`Workout`-Aktivitäten der Woche)
  - Berechnung weiterhin in `useMemo` (`weekStats`, Dependencies `[displayPlanJson, weekActivities, monday]`) — `completedCount`/`totalCount` werden intern berechnet, aber nicht mehr angezeigt (nur noch für die Ausblend-Bedingung genutzt)
  - Ausblend-Bedingung: nur wenn `weekActivities.length > 0 ODER completedCount > 0` (verhindert leere Karte bei zukünftigen Wochen ohne jegliche Aktivität)
  - Mobile: `flex-wrap` auf der Werte-Zeile statt Abschneiden

**Coach-Chat:**
- Supabase-persistente Messages (chat_messages)
- Thread-ID aus localStorage
- buildCoachContext() + COACH_SYSTEM_PROMPT bei jedem Message
- Typing-Indicator
- Neue-Gespräch-Button
- Auto-resize Textarea

**Coach-System (Kapitel 18):**
- Equipment-Sektion in Profile.tsx (Checkboxen + max_kg für Kurzhanteln, Gym-Mutex-Logik)
- Ästhetik-Ziele in Profile.tsx (Drag-and-drop Ranking via @dnd-kit, nur bei "Muskelaufbau" oder "Gewicht reduzieren")
- athletes-Schema: `equipment JSONB` + `aesthetic_goals JSONB`
- LAUF_COACH_PROMPT, RAD_COACH_PROMPT, KRAFT_COACH_PROMPT in coachPrompt.ts
- buildSpecialistContext(athleteId, sport) in coachContext.ts
- Coach-Routing in ActivityDetail.tsx (getCoachPrompts, parallel context build)
- Echtzeit-Alert in Dashboard.tsx (Claude-Konfliktcheck inkl. `recovery_required`-Kontext, sessionStorage-Gate, Amber-Banner + Modal)
- "Plan anpassen" persistiert echten Wochenplan (INSERT `weekly_plans` + `coach_decisions` `plan_adjusted`, kein reiner Text-Modal mehr)
- `coach_decisions.related_activity_id UUID` (FK→activities) — DB-Migration angewendet
- `triggerRecoveryExtraction(analysisText, athleteId, activityId)` Helper in ActivityDetail
- On-load Recovery-Check: fehlende Extractions für bestehende Analysen werden nachgeholt
- `buildCoachSystemPrompt(athleteId): Promise<string>` — dynamischer Hauptcoach-Prompt
- `calculateSeasonPhase()`, `calculateHRZones()`, `calculateZ2HRRange()`, `calculatePaceReference()` — exportierte Helpers in coachContext.ts
- **Dynamische Z2-Pace-Kalibrierung (5. Juli 2026) — ✅ Implementiert:** `calculateDynamicZ2Pace()` berechnet die Z2-Trainingspace aus den letzten 8 qualifizierenden echten Läufen (HF in Z2-Range, distanzgewichteter Durchschnitt) statt ausschließlich aus der 5k-Bestzeit-Formel; ab 3 Läufen aktiv, sonst Fallback auf die bisherige Formel; Zielpace/Schwellenpace bleiben davon unberührt aus der 5k-PB
- `athletes.season_phase_override` + `athletes.best_5k_seconds` — neue DB-Felder (Migration angewendet)
- Trainingsphase-Sektion in Profile.tsx mit Segmented Control (Auto/Override)
- `activeSport`-Parameter in `buildCoachSystemPrompt()` + `buildCoachContext()`: FTP/W-kg technisch aus dem Kontext entfernt bei Lauf-/Kraft-fokussierten Analysen (kontextuelle Blindheit strukturell statt nur per Prompt-Anweisung)
- **Bugfix Datumsfehler in Coach-Analysen (2. Juli 2026):** `[COACH-ENTSCHEIDUNGEN]` weist Aktivitätsdatum (via `related_activity_id`) getrennt von `created_at` aus; `[AKTUELLER WOCHENPLAN]` bettet Kalenderdatum direkt in die Mo–So-Tagesschlüssel ein (`planJsonWithDates()`); `[LETZTE AKTIVITÄTS-ANALYSE]` nutzt `toLocalDateStr()` statt `date.slice(0,10)` — siehe Kapitel 11

**Nutzerdaten & Feature-Flags:**
- `athletes.gender`, `athletes.birth_year`, `athletes.resting_hr` — neue DB-Felder (Migration angewendet)
- `athletes.features JSONB` — Feature-Flags pro User (Migration angewendet)
- `src/lib/features.ts`: `FeatureFlags`, `DEFAULT_FEATURES`, `useFeatures()`
- Profil ALLGEMEIN: Geschlecht (Segmented Control) + Geburtsjahr (Number Input)
- Profil LEISTUNGSDATEN: Ruheherzfrequenz nach Max HF
- BottomNav: selbst-ladendes Feature-Gate (Plan/Coach/Ziele bedingt)
- Dashboard: Filter-Buttons Rad/Kraft bedingt
- WeeklyPlan/Chat/Goals: Redirect zu /dashboard wenn Feature disabled
- `buildCoachSystemPrompt`: Alter, W/kg, HF-Reserve, Karvonen-Zonen wenn `resting_hr` vorhanden

**Multi-User Vorbereitung (RLS):**
- `set_athlete_context` Supabase-Funktion (SECURITY DEFINER)
- RLS-Policies auf allen 6 Tabellen (athletes, activities, season_goals, weekly_plans, coach_decisions, chat_messages)
- `getValidAccessToken()` + `restoreSessionFromSupabase()`: fire-and-forget `set_athlete_context` RPC
- Hinweis: pgBouncer Transaction Mode limitiert die Effektivität (Session-Variablen persistent nur in Session Mode)

**Sicherheit:**
- STRAVA_CLIENT_SECRET nie im Browser-Bundle
- ANTHROPIC_API_KEY nie im Browser-Bundle
- Prompt-Size-Limit (80k Zeichen)
- max_tokens Cap (4.096)
- Null-Guards für fehlende Athlete/Activity-Daten

---

### Nicht implementiert ❌

- **Supabase Auth / Multi-User-Login** — kein Registrierungsformular, kein E-Mail/Passwort-Login; nur Strava OAuth
- **Dynamischer System-Prompt** — ✅ Implementiert: `buildCoachSystemPrompt(athleteId)` lädt Athleten-Daten + A-Event aus Supabase; HF-Zonen, Pace-Referenz und Saison-Phase werden dynamisch berechnet
- **Hevy API-Integration** — Hevy-Daten kommen ausschließlich via Strava description; kein `hevy_api_key`, keine eigene `strength_workouts`-Tabelle
- **Body Check-in** — implementiert (Foto-Upload + Claude Vision + `body_checkins`-Tabelle) und am 1. Juli 2026 vollständig wieder entfernt (Produktentscheidung, kein Bugfix) — nicht Teil der App, siehe Hinweis am Ende der Datei
- **Kraftcoach-Ästhetik-Bewertung** — Equipment + aesthetic_goals werden zwar als Kontext mitgeschickt, aber es gibt kein automatisches Übungs-Matching / Lücken-Identifikation (Phase D aus Kap. 18)
- **Aktivitäts-Matching** ✅ — DayCards zeigen Status completed/missed/pending; Tap auf completed → ActivityDetail
- **Recovery-Extraktion für bestehende Analysen** — ✅ Behoben: ActivityDetail prüft beim Laden einer bestehenden `claude_analysis` ob bereits ein `coach_decisions`-Eintrag mit `related_activity_id = act.id` und `decision_type = 'recovery_required'` existiert. Falls nicht → fire-and-forget Extraction wird nachträglich getriggert.
- **CTL/ATL/TSB Fitness-Kurve**
- **Push Notifications**
- ~~Bottom-Navigation Mobile~~ ✅ Implementiert
- **Aktivitäts-spezifischer Chat-Thread**
- **OAuth State-Parameter** (CSRF-Schutz bei OAuth-Flow)

---

## 17. Feature-Flags

Feature-Flags steuern pro User welche Funktionen sichtbar und zugänglich sind. Keine eigene Verwaltungs-UI — Flags werden direkt in Supabase gesetzt.

### Felder

```typescript
// src/lib/features.ts
interface FeatureFlags {
  cycling: boolean      // Radfahren Tab/Filter/Sportart-Pill
  running: boolean      // immer true — Basis-Feature, nicht abschaltbar per UI
  strength: boolean     // Krafttraining Tab/Filter/Sportart-Pill/Sektion
  weekly_plan: boolean  // /plan Route (Redirect zu /dashboard wenn false)
  coach_chat: boolean   // /chat Route (Redirect zu /dashboard wenn false)
  goals: boolean        // /goals Route (Redirect zu /dashboard wenn false)
}
```

### Feature-Flags per User anpassen

1. Supabase Dashboard → Table Editor → athletes
2. Zeile des Users finden (via `name` oder `strava_athlete_id`)
3. `features` Spalte editieren (JSON direkt im Table Editor)
4. Speichern — wirkt sofort beim nächsten App-Load

**Beispiel Nur-Lauf-User:**
```json
{
  "cycling": false,
  "running": true,
  "strength": false,
  "weekly_plan": true,
  "coach_chat": true,
  "goals": true
}
```

### Auswirkungen

| Flag | Effekt bei `false` |
|---|---|
| `cycling` | Kein Rad-Tab in BottomNav; kein Rad-Filter im Dashboard; kein Radfahren-Pill in Profil |
| `strength` | Kein Krafttraining-Pill; KRAFTTRAINING-Sektion versteckt; kein Kraft-Filter im Dashboard |
| `weekly_plan` | `/plan` → Redirect zu `/dashboard` |
| `coach_chat` | `/chat` → Redirect zu `/dashboard` |
| `goals` | `/goals` → Redirect zu `/dashboard` |

### Implementierung

- `src/lib/features.ts`: `FeatureFlags` Interface, `DEFAULT_FEATURES` (alle true), `useFeatures(athlete)` Funktion
- `useFeatures(athlete)`: merged DEFAULT_FEATURES mit `athlete.features` aus DB (Spread — neue Flags haben automatisch default true)
- `BottomNav.tsx`: selbst-lädt features aus Supabase (einmalig per mount); filtert Tabs
- Seiten mit Redirect: laden athlete inkl. features und navigieren zu `/dashboard` wenn Feature disabled

---

## 18. Multi-User Vorbereitung (RLS)

Datentrennung via PostgreSQL Row Level Security. Basis für zukünftigen Multi-User-Betrieb.

### Konzept

Die App nutzt kein Supabase Auth. Als Ersatz wird `app.strava_athlete_id` als PostgreSQL-Session-Variable gesetzt und in RLS-Policies referenziert.

**Einschränkung:** Supabase verwendet pgBouncer im Transaction Mode. Session-Variablen (via `set_config`) sind in diesem Modus nicht persistent über Requests hinweg. Die Policies sind daher eine Vorbereitung für Session-Mode-Pooling oder direkten DB-Zugriff (Multi-User-Implementierung würde Supabase Auth oder eigene JWT-Claims erfordern).

**Praktische Konsequenz:** Bis Supabase Auth eingeführt wird, ist der Datenschutz zwischen mehreren Athleten ausschließlich auf Anwendungsebene (WHERE athlete_id = X in jeder Query) sichergestellt — nicht auf Datenbankebene. Das reicht für eine kleine, vertrauenswürdige Nutzergruppe (2-3 Personen), ist aber kein Schutz vor gezieltem Zugriff über die Supabase anon key API. Vor öffentlichem Multi-User Onboarding: Supabase Auth zwingend erforderlich (siehe Roadmap).

### Supabase Funktion

```sql
CREATE OR REPLACE FUNCTION set_athlete_context(athlete_id TEXT)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.strava_athlete_id', athlete_id, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### RLS Policies

Alle 6 Datentabellen haben restrictive Policies:
- `athletes`: `strava_athlete_id = NULLIF(current_setting('app.strava_athlete_id', true), '')::bigint`
- Alle anderen: `athlete_id IN (SELECT id FROM athletes WHERE strava_athlete_id = ...)`

### Supabase Funktion — `delete_athlete_account` (Self-Service Kontolöschung, seit 12. Juli 2026)

Zweite `SECURITY DEFINER`-Funktion nach demselben Muster wie `set_athlete_context`, für die Self-Service-Kontolöschung in `Profile.tsx`:

```sql
CREATE OR REPLACE FUNCTION delete_athlete_account(p_athlete_id UUID)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM chat_messages   WHERE athlete_id = p_athlete_id;
  DELETE FROM coach_decisions WHERE athlete_id = p_athlete_id;
  DELETE FROM weekly_plans    WHERE athlete_id = p_athlete_id;
  DELETE FROM activities      WHERE athlete_id = p_athlete_id;
  DELETE FROM season_goals    WHERE athlete_id = p_athlete_id;
  DELETE FROM athletes        WHERE id = p_athlete_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION delete_athlete_account(UUID) TO anon, authenticated;
```

Läuft als einzelne Funktion in einer Transaktion — schlägt irgendein DELETE fehl (z. B. FK-Verletzung), rollt Postgres automatisch alles zurück. Reihenfolge zwingend wegen FK-Constraints (`coach_decisions.related_plan_id → weekly_plans.id`, `coach_decisions.related_activity_id → activities.id`, `chat_messages.activity_id → activities.id`). Aufruf ausschließlich mit der `athlete_id` aus dem geladenen Session-Athleten (siehe Kapitel 9 „Profile.tsx — Konto löschen").

### Client-seitige Aktivierung

In `src/lib/strava.ts`:
- `getValidAccessToken()`: ruft `set_athlete_context` als fire-and-forget vor Token-Rückgabe
- `restoreSessionFromSupabase()`: ruft `set_athlete_context` nach Restore des stravaId

```typescript
void supabase.rpc('set_athlete_context', { athlete_id: String(athlete.strava_athlete_id) })
```

---

## 19. Supabase-Projektdetails

- **Name:** peakform
- **Project ID:** `thjihbyyelqrrvdinzti`
- **URL:** `https://thjihbyyelqrrvdinzti.supabase.co`
- **Region:** eu-central-1
- **RLS:** Aktiv auf allen Tabellen; Policy basiert auf `app.strava_athlete_id` Session-Variable via `set_athlete_context()` RPC (siehe Kapitel 18)

---

## 18. Coach-System

### 18.1 Architektur-Überblick

PeakForm verwendet ein zweistufiges Coach-System:

**Hauptcoach (immer aktiv)**
- Kennt alle Athleten-Daten: FTP, Lauf-PB, Kraftvolumen, Gewichte, Ästhetik-Ziele
- Kennt alle aktiven Saison-Ziele (A/B/C-Priorität, alle Sportarten)
- Kennt die gesamte Trainingshistorie (letzte 8 Wochen, alle Sportarten)
- Kennt den aktuellen und geplanten Wochenplan
- Überwacht Übertraining, fehlende Variation, Konflikte zwischen Sportarten
- Greift aktiv ein bei kritischen Konflikten (Echtzeit-Alert)
- Gibt vollständige Gesamtbewertung beim wöchentlichen Review
- Delegiert Aktivitätsanalysen unsichtbar an den jeweiligen Spezialcoach

**Spezialcoaches (dynamisch, an aktive Sportarten gebunden)**
- Nur für aktive Sportarten im Athleten-Profil vorhanden
- Aktuell möglich: Laufcoach, Radcoach, Kraftcoach
- Jeder Coach hat tiefes domänenspezifisches Wissen
- Kontextuelle Blindheit: jeder Coach wertet NUR seine Sportart
- Kennt den Gesamtkontext (via Hauptcoach-Kontext-Schicht) aber interpretiert ihn nur aus seiner Sportart-Perspektive
- Analyse-Output ist eine einzige kohärente Antwort (nicht zwei separate Blöcke)

---

### 18.2 Coach-Routing

**Aktivitätsanalyse:**
```
Aktivitätstyp → Spezialcoach
'Run' | 'VirtualRun'        → Laufcoach
'Ride' | 'VirtualRide'      → Radcoach
'WeightTraining'            → Kraftcoach
Alle anderen Typen          → Hauptcoach (generisch)
```

**Chat (global):** Immer Hauptcoach

**Wochenplan-Generierung:** Hauptcoach koordiniert, kennt alle Sportarten-Constraints

**Wochenreview:** Hauptcoach — vollständige Gesamtbewertung aller Sportarten

**Echtzeit-Alerts:** Hauptcoach — bei kritischen Konflikten nach neuer Aktivität

---

### 18.3 Echtzeit-Alert Logik

Nach jedem Strava-Sync in `Dashboard.tsx`:

**Ablauf (Supabase-persistiert je Plan-Version, kein `sessionStorage` mehr — siehe Bugfix 12. Juli 2026):**
1. Aktuellen Wochenplan (`weekly_plans`, `select('id, plan_json')`, neueste `version`), neueste Aktivität dieser Woche UND den `coach_decisions`-Eintrag mit `decision_type='recovery_required'` zur zeitlich jüngsten Aktivität der letzten 48h parallel aus Supabase laden (Join `related_activity_id → activities.date`, `limit(1)` — siehe Bugfix 3. Juli 2026 unten)
2. Wenn ein Plan existiert: prüfen, ob für dessen `id` bereits ein `coach_decisions`-Eintrag mit `decision_type='realtime_alert_dismissed'` existiert (`related_plan_id = plan.id`) — wenn ja, Check komplett überspringen (kein Claude-Call, kein Banner)
3. Check läuft, sobald ein Plan existiert UND noch nicht dismissed wurde UND (eine neue Aktivität diese Woche vorliegt ODER eine frische Recovery-Empfehlung existiert) — läuft also auch ohne neue Strava-Aktivität, wenn der Coach z.B. gerade erst eine `recovery_required`-Empfehlung aus einer Aktivitätsanalyse extrahiert hat
4. Claude-Call (`max_tokens: 150`): Prompt enthält Plan-JSON + Aktivitätsdaten (oder Hinweis "keine neue Aktivität") + die Coach-eigenen Recovery-Einschätzungen der letzten 48h (Freitext, nicht nur Rohdaten); Claude antwortet AUSSCHLIESSLICH mit `{"conflict": bool, "message": string|null}`
   Plan-JSON wird dabei über `planJsonWithDates(plan.plan_json, getISOMonday(new Date()))` (aus `coachContext.ts`, dort für `[AKTUELLER WOCHENPLAN]` exportiert, siehe Kapitel 11) angereichert — die Mo–So-Tageskürzel bekommen das konkrete Kalenderdatum direkt als Teil des Keys (z. B. `"Sa 4.7.2026"` statt nur `"Sa"`), damit Claude die Wochentag↔Datum-Zuordnung nicht selbst berechnen muss (Bugfix 4. Juli 2026, siehe unten)
5. Bei `conflict: true`: Amber-Banner mit Claude-Message anzeigen; die geladene Plan-`id` wird im State (`alertPlanId`) gehalten, damit "Verwerfen" (siehe unten) weiß, welche Plan-Version es dismissed

**Alert-Format (Amber-Banner):**
```
⚠  [Claude-generierte Konflikterklärung — max 20 Wörter]
   [Plan anpassen]   [Verwerfen]
```

**"Plan anpassen" — persistiert tatsächlich:**
1. Claude-Call (`max_tokens: 2048`) mit Plan-JSON + Konflikt-Beschreibung → liefert einen strukturierten neuen Plan im gleichen JSON-Format wie `generatePlan()` (`{summary, days: {Mo…So}}`), nicht mehr nur Freitext
2. `weekly_plans` INSERT (nie UPDATE) — gleiche Versionierungs-Logik wie `generatePlan()`/`startReview()` (`version = max(version)+1` je `week_start`), `change_reason = "Echtzeit-Alert: " + Konflikt-Message`
3. `coach_decisions` INSERT: `decision_type='plan_adjusted'`, `reasoning` = Plan-Summary, `related_plan_id` → neue `weekly_plans`-Zeile
4. Modal zeigt danach "Plan aktualisiert ✓" mit Button "Zum Wochenplan" (statt rohem Claude-Text); Amber-Banner wird automatisch verworfen
5. `WeeklyPlan.tsx` lädt beim nächsten Öffnen automatisch die neueste Version (bestehende `order('version', desc).limit(1)`-Logik deckt das ab, keine Änderung nötig)
6. Schlägt der Save fehl (z.B. ungültiges JSON von Claude): Modal zeigt Fehlermeldung, kein Teil-Save

**"Verwerfen" — persistiert seit Bugfix 12. Juli 2026 dauerhaft:**
1. `coach_decisions` INSERT: `decision_type='realtime_alert_dismissed'`, `decision_summary` = Konflikt-Message, `related_plan_id` → die Plan-Version, für die der Banner angezeigt wurde (`alertPlanId`)
2. UI-seitig sofort ausgeblendet (`setAlertDismissed(true)`), unabhängig vom Insert-Ergebnis; schlägt der Insert fehl, bleibt es bei einer rein session-lokalen Ausblendung, der Banner kann nach Neustart erneut erscheinen (kein Retry-Mechanismus, bewusst einfach gehalten)
3. Der Dismiss gilt exklusiv für die konkrete Plan-`id` — sobald eine neue `weekly_plans`-Version entsteht (z.B. durch "Plan anpassen", ein Wochenreview oder eine manuelle Planänderung), greift der alte Dismiss nicht mehr und ein neuer echter Konflikt kann wieder gemeldet werden

**Nicht-kritische Abweichungen:** Kein Alert — wird beim wöchentlichen Review besprochen.

#### Bugfix 12. Juli 2026 — Amber-Banner erschien nach App-Neustart erneut, obwohl bereits verworfen

**Symptom:** Nutzer klickte "Verwerfen" auf den Echtzeit-Alert-Banner, nach einem echten App-Neustart (besonders iOS PWA — Prozess komplett beendet und neu gestartet, nicht nur Reload) erschien derselbe Banner erneut, teils mehrfach.

**Root Cause:** Das Gate lief ausschließlich über `sessionStorage.getItem/setItem('peakform_alert_{weekStart}')` — gilt nur innerhalb einer Browser-/PWA-Session. Bei echtem Prozess-Neustart ist `sessionStorage` leer, der Claude-Konflikt-Check läuft erneut; besteht der zugrunde liegende Konflikt (Plan unverändert) weiterhin, erscheint der Banner erneut. "Plan anpassen" war unkritisch, da es bereits eine neue `weekly_plans`-Version persistiert, die den alten Konflikt obsolet macht. "Verwerfen" (`setAlertDismissed(true)`) persistierte dagegen nichts — reiner React-State, ging bei jedem Reload/Neustart verloren.

**Fix:** `sessionStorage`-Gate vollständig entfernt (kein Parallelbetrieb zweier Gates). Stattdessen: "Verwerfen" schreibt einen `coach_decisions`-Eintrag `decision_type='realtime_alert_dismissed'` mit `related_plan_id` = aktuelle `weekly_plans.id`; vor dem Claude-Call wird geprüft, ob für die geladene Plan-`id` bereits ein solcher Eintrag existiert — wenn ja, wird der Check komplett übersprungen. Da der Dismiss an eine konkrete Plan-`id` (nicht an `week_start`) gebunden ist, macht jede neue Plan-Version (Plan anpassen/Review/manuelle Änderung) den alten Dismiss automatisch obsolet, ein neuer echter Konflikt wird wieder erkannt. Verifiziert per direktem SQL gegen die Produktions-DB (Dummy-Athlet/-Plan/-Decision in einer `BEGIN…ROLLBACK`-Transaktion, kein Testdaten-Rückstand): Query vor Dismiss liefert keine Zeile, nach Dismiss genau eine Zeile, nach Anlage einer neuen Plan-Version wieder keine Zeile.

#### Bugfix 3. Juli 2026 — veraltete `recovery_required`-Empfehlung blieb nach erledigter Aktivität im Alert sichtbar

**Symptom:** Amber-Banner zeigte eine überholte Erholungs-Warnung ("Do-Lauf prüfen"), obwohl der referenzierte Donnerstagslauf bereits absolviert und analysiert war.

**Root Cause:** Die Query lud *alle* `recovery_required`-Einträge der letzten 48h nach `coach_decisions.created_at` — ungefiltert nach Relevanz. `created_at` ist aber der Zeitpunkt der Extraktion (`triggerRecoveryExtraction`), nicht das Datum der referenzierten Aktivität. Der "on-load"-Backfill-Pfad (Extraktion beim Öffnen alter, noch nicht extrahierter Aktivitäten) kann dadurch Einträge für wochenalte Aktivitäten mit einem sehr aktuellen `created_at` erzeugen — diese landeten im 48h-Fenster und verdrängten/verwässerten die tatsächlich aktuelle Empfehlung im Claude-Prompt. Es gab keinen Resolved/Superseded-Mechanismus, der einen Eintrag nach Eintreten der referenzierten Folge-Aktivität als erledigt markiert.

**Fix:** Query filtert/sortiert jetzt nach dem Datum der **referenzierten Aktivität** (`activities!related_activity_id!inner(date)`, `gte('activities.date', ...)`, `order('date', {referencedTable:'activities'})`) statt nach `coach_decisions.created_at`, und lädt nur noch den einen Eintrag zur jüngsten Aktivität (`limit(1)`). Gleiches Pattern in `WeeklyPlan.tsx` (`generatePlan()`/`startReview()`) angewendet — dort ohne `limit(1)`, da beim Plan-Erstellen/Review bewusst mehrere gleichzeitig aktive Restriktionen (z.B. Lauf- und Rad-Einschränkung parallel) berücksichtigt werden sollen.

#### Bugfix 4. Juli 2026 — Wochentag/Datum-Selbstwiderspruch im Echtzeit-Alert

**Symptom:** Amber-Banner bezeichnete eine Aktivität mit `date=4.7.2026` (tatsächlich ein Samstag) fälschlich als „Freitag (4.7.)"; eine zweite Generierung enthielt sogar einen Selbstwiderspruch innerhalb derselben Nachricht ("Samstag-Lauf ... am Freitag (4.7.)").

**Root Cause:** Der Konflikt-Check-Prompt in `Dashboard.tsx` wird unabhängig von `buildCoachContext()` zusammengesetzt (nur `buildCoachSystemPrompt()` als System-Rolle) und reichte `plan.plan_json` bislang roh — also nur mit Mo–So-Kürzeln ohne Kalenderdatum — an Claude weiter. Der 2.-Juli-Fix hatte `planJsonWithDates()` nur in `buildCoachContext()` (`[AKTUELLER WOCHENPLAN]`) verankert, nicht aber in diesem zweiten, separaten Prompt-Pfad. Claude musste die Wochentag↔Datum-Zuordnung für die Plan-Tage dadurch selbst berechnen und hat sich dabei verrechnet.

**Fix:** `planJsonWithDates()` in `coachContext.ts` exportiert und im Konflikt-Check-Prompt wiederverwendet: `JSON.stringify(planJsonWithDates(plan.plan_json, getISOMonday(new Date())), null, 2)` statt `JSON.stringify(plan.plan_json, null, 2)`. `getISOMonday()` (aus `dateUtils.ts`, UTC-slice-frei) liefert den `Date`-Montag für die Datums-Berechnung — bewusst unabhängig von der lokalen `mondayOf()`-Hilfsfunktion in `Dashboard.tsx`, die weiterhin `toISOString().slice(0, 10)` für den `week_start`-String/Session-Key nutzt (separates, hier nicht behobenes Risiko, siehe Diagnose-Notiz).

---

### 18.4 Spezialcoach-Prompts

#### Laufcoach

**Expertise:**
- Periodisierungsmodelle für Laufen (Daniels Running Formula, Lydiard-Methode)
- HF-Zonen-basiertes Training, Pace-Entwicklung
- Laufökonomie, Kadenz, Technik
- Verletzungsprävention: Achillessehne, Knie, Hüftbeuger, IT-Band
- Readaptation nach Laufpause

**Kontextuelle Blindheit:**
- Wertet niemals FTP oder Wattwerte direkt
- Verwendet niemals die Begriffe "FTP" oder "% FTP" in einer Laufanalyse — auch nicht wenn die Aktivität eigene Watt-Werte enthält (explizit im Prompt verankert, siehe unten)
- Erwähnt Radausdauer nur aus Laufperspektive: "Deine aerobe Basis vom Radfahren hilft dir beim Z2-Laufen"
- Kommentiert kein Krafttraining direkt — nur wie es die Laufleistung beeinflusst
- FTP/W-kg sind bei Lauf-Analysen technisch nicht im Kontext vorhanden (siehe Kapitel 11/12, `activeSport`-Parameter) — die Blindheit ist damit nicht nur eine Prompt-Anweisung, sondern strukturell erzwungen

**Laufleistungsmesser (Stryd o.ä.):**
Falls die Lauf-Aktivität eigene Leistungsdaten (Watt) liefert, sind diese Werte NICHT mit Rad-FTP vergleichbar (andere Watt-Skala). Der Prompt weist den Laufcoach explizit an, solche Watt-Werte ausschließlich für Trend-Vergleiche mit früheren Läufen zu nutzen — niemals als Prozent einer FTP-Zahl.

**Analyse-Fokus:**
- Pace vs. HF-Relation (Effizienz)
- HF-Zonen-Verteilung der Einheit
- Vergleich mit Zielpace (8k-Event)
- Wochenkm-Trend
- Gesamtkontext: Wo steht diese Einheit im 14-Wochen-Plan?

---

#### Radcoach

**Expertise:**
- Trainingszonen nach Coggan (FTP-basiert)
- Normalized Power (NP), Intensity Factor (IF), Training Stress Score (TSS)
- Periodisierung für Granfondos und Rennradrennen
- Zwift-Training vs. Outdoor-Training
- Höhenmeter-spezifische Belastungssteuerung

**Kontextuelle Blindheit:**
- Kommentiert keine Laufpace oder Lauf-HF direkt
- Erwähnt Lauftraining nur aus Rad-Perspektive: "Die Laufeinheiten belasten die Beine zusätzlich — halte den NP heute unter 75% FTP"
- Bewertet kein Krafttraining direkt

**Analyse-Fokus:**
- NP vs. FTP (Intensity Factor)
- TSS und kumulativer Stress
- HF-Drift über die Einheit
- Watt-Kurve: Peaks, Einbrüche, Gleichmäßigkeit
- Vergleich mit letzten vergleichbaren Rides

---

#### Kraftcoach

**Expertise:**
- Hypertrophie-Protokolle (Progressive Overload, RPE-basiertes Training)
- Laufunterstützung durch Krafttraining (Hüftstabilität, Core, Beinkraft)
- Ästhetik-orientiertes Training (Muskelgruppen-spezifisch)
- Home-Gym Übungsalternativen basierend auf verfügbarem Equipment
- Workout-Progression über Wochen (Workout I / II / III Rotation)

**Kontextuelle Blindheit:**
- Bewertet keine Lauf-Pace oder Rad-Watt
- Erwähnt Ausdauertraining nur aus Kraftperspektive: "Nach dem gestrigen langen Ride empfehle ich heute leichteres Gewicht — Muskelermüdung beeinflusst die Kraftleistung"
- **Kennt die Lauf-Saisonphase (Readaptation/Grundlage/Wettkampf/Taper) nicht** — `[ATHLETEN-PROFIL]` enthält bei `activeSport === 'strength'` keine Phase-Zeile (kontextuelle Blindheit auf Kontext-Ebene, analog zur FTP/W-kg-Blindheit, siehe Kapitel 11/12). Grund: Krafttraining verfolgt ein eigenständiges Ästhetik-/Hypertrophie-Ziel, keine Lauf-Periodisierung — die Phase-Labels sind lauf-spezifisch formuliert ("Sehnen, Gelenke und Laufmuskulatur readaptieren") und wurden vom Coach sonst fälschlich auf Krafttraining-Analysen übertragen (Bugfix 3. Juli 2026, siehe unten)
- Statt der Phase bekommt der Kraftcoach einen eigenen `## TRAININGSZIEL KRAFTTRAINING`-Block mit Körperzielen + Ästhetik-Prioritäten (`strengthGoalSection` in `coachPrompt.ts`)
- `KRAFT_COACH_PROMPT` enthält zusätzlich einen expliziten Blindheits-Satz: "Verwende niemals Lauf-Periodisierungsbegriffe ('Readaptation', 'Laufeinstieg', 'Grundlagenaufbau', 'Phase 1/2/3/4' o.ä.) in einer Krafttraining-Analyse"

#### Bugfix 3. Juli 2026 — Lauf-Periodisierung leckte in Krafttraining-Analysen

**Symptom:** Krafttraining-Analysen erwähnten "Phase 1 — Readaptation" oder "Laufeinstieg", obwohl `KRAFT_COACH_PROMPT` diese Begriffe nirgends referenziert.

**Root Cause:** `phaseSection` in `buildCoachSystemPrompt()` wurde — anders als FTP/W-kg (`showCyclingPower`) — unconditional in jeden System-Prompt eingefügt, unabhängig von `activeSport`. Die Phase-Labels aus `calculateSeasonPhase()` sind wörtlich lauf-spezifisch ("Sehnen, Gelenke und Laufmuskulatur readaptieren"); da sie im selben System-Prompt wie der Kraft-Spezialistenauftrag standen, übertrug Claude sie eigenständig auf die Krafttraining-Analyse.

**Fix:** Neue Variable `showSeasonPhase = activeSport !== 'strength'` gated die Phase-Sektion analog zu `showCyclingPower`. Bei `activeSport === 'strength'` wird stattdessen `strengthGoalSection` (`## TRAININGSZIEL KRAFTTRAINING`) eingefügt. Zusätzlich expliziter Blindheits-Satz in `KRAFT_COACH_PROMPT` als zweite Verteidigungslinie.

**Ästhetik-Integration:**
- Kennt die Ästhetik-Ziele des Athleten (Muskelgruppen-Prioritäten + Freitext)
- Bewertet jede Einheit: "Workout II hatte 3 Übungen für Po/Hüfte — das zahlt auf dein primäres Ästhetik-Ziel ein"
- Identifiziert Lücken: welche priorisierten Muskelgruppen werden in Workout I/II/III zu wenig trainiert
- Gibt konkrete Ersetzungsvorschläge (nicht komplette Workout-Umschreibungen):
  "Ersetze in Workout II die Beinpresse durch Hip Thrusts 4×10 — direkterer Po-Fokus, gleiche Belastung"
- Berücksichtigt verfügbares Equipment bei jedem Vorschlag

---

### 18.5 Athleten-Profil Erweiterungen

#### Equipment (neues Feld: `equipment` JSONB in athletes-Tabelle)

```json
{
  "dumbbells": { "active": true, "max_kg": 32 },
  "bands": { "active": true },
  "bodyweight": { "active": true },
  "pullup_bar": { "active": true },
  "gym": { "active": false }
}
```

**UI:** Checkbox-Liste mit Gewichtsangabe nur bei Kurzhanteln.  
Wenn "Gym" aktiv → alle anderen Felder werden deaktiviert (Gym = alles verfügbar).

#### Ästhetik-Ziele (neues Feld: `aesthetic_goals` JSONB in athletes-Tabelle)

```json
{
  "priorities": ["glutes", "shoulders", "arms", "core", "chest", "back", "legs"],
  "notes": "Linker Bizeps schwächer als rechter — ausgleichen"
}
```

**Muskelgruppen (Mehrfachauswahl + Drag & Drop Ranking):**
- Po / Hüfte (glutes)
- Schultern (shoulders)
- Arme (arms)
- Core / Bauch (core)
- Brust (chest)
- Rücken (back)
- Beine (legs)

**Reihenfolge = Priorität** — erste Position = höchste Priorität für Kraftcoach.  
Plus Freitext-Feld für Nuancen.

---

### 18.6 Technische Implementierung

#### `buildSpecialistContext(athleteId, sport)` — implementiert ✅

Lädt sportart-spezifische Historien (letzte 60 Tage). Wird parallel zu `buildCoachContext()` aufgerufen.

```
'running'  → Letzte 10 Läufe: Datum | km | Pace min/km | Ø HF
'cycling'  → FTP + Letzte 10 Ausfahrten: Datum | km | NP W (% FTP) | TSS | Ø HF
'strength' → Equipment (aktive Geräte) + Ästhetik-Prioritäten (wenn relevant)
             + Letzte 5 Kraft-Sessions: Datum | Name | Description-Snippet
```

#### Claude-Call Struktur pro Coach — implementiert ✅

```
system:  await buildCoachSystemPrompt(athleteId)      [dynamisch aus DB]
         + '\n\n' + LAUF/RAD/KRAFT_COACH_PROMPT       [statisch, sportart-spezifisch]

user:    buildCoachContext(athleteId)                  [8-Abschnitte Hauptkontext]
         + buildSpecialistContext(athleteId, sport)    [sportart-spezifische Historien]
         + Aktivitätsdaten (Stats, Laps, Hevy-Übungen)
```

Alle drei Promises werden parallel aufgelöst in `runAnalysis()`.

Routing in `ActivityDetail.tsx` via `getSpecialistPrompt(activityType)`:
```
'Run'|'VirtualRun'|'TrailRun'                         → LAUF_COACH_PROMPT, sport:'running'
'Ride'|'VirtualRide'|'MountainBikeRide'|'GravelRide'  → RAD_COACH_PROMPT,  sport:'cycling'
'WeightTraining'|'Workout'                             → KRAFT_COACH_PROMPT, sport:'strength'
Alle anderen                                           → kein Specialist, sport:null
```

#### Echtzeit-Alert — implementiert ✅

Beschreibung: siehe 18.3. Claude-basierter Check (nicht heuristisch-JS), Dismiss-Gate persistiert je Plan-Version über `coach_decisions` (`realtime_alert_dismissed`), kein sessionStorage mehr. Bezieht `recovery_required`-Coach-Entscheidungen der letzten 48h mit ein (läuft auch ohne neue Strava-Aktivität). "Plan anpassen" persistiert eine neue `weekly_plans`-Version inkl. `coach_decisions`-Eintrag (`plan_adjusted`), statt nur Freitext anzuzeigen.

---

### 18.7 Implementierungs-Status

**Phase A — Profil-Erweiterungen ✅ DONE**
- Equipment-Sektion in Profile.tsx (Checkboxen + Kurzhantel-Gewicht, Gym-Mutex)
- Ästhetik-Ziele in Profile.tsx (Drag & Drop Ranking via @dnd-kit + Freitext)
- Supabase Schema: `equipment JSONB` + `aesthetic_goals JSONB` in athletes
- TypeScript-Types: `EquipmentConfig`, `AestheticGoals` in supabase.ts

**Phase B — Specialist Prompts ✅ DONE**
- `LAUF_COACH_PROMPT`, `RAD_COACH_PROMPT`, `KRAFT_COACH_PROMPT` in `coachPrompt.ts`
- `buildSpecialistContext(athleteId, sport)` in `coachContext.ts`
- `getCoachPrompts(type)` + Coach-Routing in `ActivityDetail.tsx`

**Phase C — Echtzeit-Alerts ✅ DONE**
- Claude-basierter Konflikt-Check nach Strava-Sync
- Dismiss-Gate persistiert je Plan-Version in `coach_decisions` (`realtime_alert_dismissed`)
- Amber-Banner + "Plan anpassen"-Modal in Dashboard.tsx

**Phase D — Kraftcoach Vollintegration ❌ OFFEN**
- Automatisches Übungs-Matching zu Ästhetik-Prioritäten
- Lücken-Identifikation (Muskelgruppen die in Workout I/II/III fehlen)
- Konkrete Ersetzungsvorschläge mit Equipment-Filter

**Phase E — Body Check-in ❌ ENTFERNT (1. Juli 2026)**
- Implementiert (`body_checkins`-Tabelle, Storage Bucket, Upload/Signed-URL-Endpoints, `BodyCheckin.tsx`, Vorwoche-Vergleich, Feedback-Integration in `buildSpecialistContext('strength')`) und anschließend vollständig zurückgebaut — Produktentscheidung, kein Bugfix. Siehe Hinweis am Ende der Datei.

---

## 19. Entfernte Features

**Body Check-in wurde implementiert und anschließend vollständig entfernt (1. Juli 2026) — nicht Teil der App.**

Umfang der Entfernung:
- DB: `body_checkins`-Tabelle gedroppt (Migration `drop_body_checkins_feature_removed`, Rollback von `create_body_checkins_table` + `create_body_checkins_storage_bucket`)
- Storage: Bucket `body-checkins` geleert und gelöscht
- Code: `src/pages/BodyCheckin.tsx`, `api/body-checkin-upload.ts`, `api/body-checkin-url.ts`, `src/lib/imageUtils.ts` gelöscht; alle Referenzen in `App.tsx`, `Dashboard.tsx`, `Profile.tsx`, `features.ts`, `coachContext.ts`, `supabase.ts`, `vite.config.ts` entfernt
- Grund: Produktentscheidung, kein Bugfix — die Diagnose eines Upload-Fehlers beim ersten Check-in eines Users führte zur Entscheidung, das Feature ganz zu streichen statt zu reparieren
