# PeakForm — Feature Roadmap

> Ideen und geplante Weiterentwicklungen.
> Erstellt: 30. Juni 2026
> Status: lebendiges Dokument — wird laufend ergänzt

---

## Legende

🔴 Kritisch / Sicherheit
🟡 Wichtig / bald umsetzen
🟢 Nice-to-have / später
💡 Idee / noch nicht entschieden

---

## 1. Offene Punkte aus der Entwicklung

### ✅ OAuth CSRF-Schutz (behoben 1.7.2026)
generateOAuthState() erzeugt UUID beim Login, AuthCallback.tsx verifiziert vor Token-Exchange. Bei Mismatch: Abbruch mit Fehlermeldung.

### ✅ Multi-User Session-Restore Fix (behoben 1.7.2026)
restoreSessionFromSupabase() nutzte LIMIT 1 (zufälliger Athlet). Jetzt: pf_athlete_id Cookie identifiziert den korrekten Athleten. Logout löscht Cookie zusätzlich.

### ✅ athlete_id-Filter bei activities-Updates in analyzeActivity() ergänzt (behoben 21.7.2026)
Anlass: zweiter echter Athlet (eigenes Android-Gerät, eigener Strava-Account) nutzt die App seitdem live. Multi-User-Isolation daraufhin geprüft (App-Level-Filter, Session-Restore, OAuth-Zuordnung, Chat) — bis auf einen Fund unauffällig: Die drei `UPDATE activities`-Aufrufe in `src/lib/activityAnalysis.ts` (streams_json/laps_json/description-Cache) filterten nur über `strava_id` (global UNIQUE, daher bisher kein echtes Datenleck), nicht zusätzlich über `athlete_id` wie die übrigen Updates in `ActivityDetail.tsx`. Jetzt konsistent mit `.eq('athlete_id', athleteId)` ergänzt. Erinnerung: RLS ist laut Kapitel 18 (SPEC.md) nicht wirksam durchgesetzt (pgBouncer Transaction-Mode) — Isolation zwischen Athleten hängt vollständig von diszipliniertem `.eq('athlete_id', ...)` in jeder Query ab, kein DB-seitiges Sicherheitsnetz.

### ✅ Onboarding-Flow (behoben/implementiert 1.7.2026)
Verpflichtender 6-Schritte-Wizard (Onboarding.tsx): Name → Sportarten+Trainingstage → Erstes Saisonziel → Leistungsdaten (optional) → Coach-Stil → Zusammenfassung. Läuft einmalig nach erstem Strava-Login, kein Skip möglich. Bestandsuser (Markus) per Migration auf onboarding_completed=true gesetzt, damit sie nicht erneut durch den Wizard müssen.

### ✅ Mid-Week Check-in (implementiert 2.7.2026)
Feedback-Button an completed DayCards im Wochenplan (Modal, Freitext). Speicherung als coach_decisions (decision_type='midweek_feedback'), UPDATE statt Duplikat bei erneutem Feedback zur selben Aktivität. Kein zusätzlicher Claude-Call — landet automatisch im bestehenden [COACH-ENTSCHEIDUNGEN]-Kontext.

### ✅ Activity-ID-Mismatch (behoben 2.7.2026)
War: WeeklyPlan.tsx nutzte match.activity.id (Supabase-UUID) statt match.activity.strava_id beim Navigieren zu ActivityDetail → Number(<uuid>) = NaN → "Aktivität konnte nicht geladen werden". Fix: korrekter Identifier (strava_id) wird jetzt konsistent verwendet.

### ✅ Datums-Bug in Coach-Analysen (behoben 2.7.2026, 3 Fundstellen)
Drei separate Ursachen für falsche Datumsangaben in Coach-Analysen: (1) coach_decisions zeigte bei midweek_feedback das Eingabedatum (created_at) statt des Aktivitätsdatums — Coach verwechselte beide. (2) [LETZTE AKTIVITÄTS-ANALYSE] nutzte rohes UTC-String-Slicing statt Lokalzeit-Formatierung (latenter Bug bei Abend-Aktivitäten). (3) Wochenplan-Kontext gab Claude nur Wochentags-Kürzel ohne konkretes Kalenderdatum — Claude musste sich das Datum selbst herleiten und verrechnete sich (falscher Wochentag in Empfehlungen). Alle drei behoben: Aktivitätsdatum wird jetzt explizit mitgegeben, lokale Formatierung durchgängig, Wochenplan-Kontext enthält pro Tag das konkrete Datum.

### ✅ Extra-Aktivität an Ruhetagen sichtbar gemacht (implementiert 4.7.2026)
matchActivityToDay() gab für Ruhetage bisher immer 'pending' zurück, unabhängig davon ob trotzdem trainiert wurde — Zusatzeinheiten verschwanden im Wochenplan spurlos. Neuer Status 'extra': blauer Rand + "Extra"-Pill statt ✓/✗, Zeile "Zusätzlich trainiert: {activity.name}", Tap navigiert wie gewohnt zu ActivityDetail.

### ✅ Fallback-Icon für unbekannte Sportarten (implementiert 4.7.2026)
ActivityIcon() (Dashboard.tsx) und TypeIcon() (WeeklyPlan.tsx) zeigten für unbekannte Strava-Typen (Swim, Yoga, Hike etc.) fälschlich ein graues Lauf-Icon. Jetzt: eigener SPORT_DISPLAY.other-Eintrag (IconOther/FaStopwatch, neutrales Grau). Bewusst NICHT angetastet: sportFromActivityType()/getSpecialistPrompt() bleiben bei null statt 'other' für unbekannte Typen — ihre null-Semantik steuert korrekt "zeige alles" (FTP/W-kg bleiben sichtbar) in coachContext.ts/coachPrompt.ts; ein 'other'-Rückgabewert hätte das fälschlich unterdrückt.

### ✅ Dashboard-Alert nannte falschen/widersprüchlichen Wochentag (behoben 4.7.2026)
Gleicher Bug-Typ wie der Datums-Fix vom 2. Juli, aber an einer vom damaligen Fix nicht erreichten Stelle: der Echtzeit-Alert-Konflikt-Check in Dashboard.tsx baut seinen Prompt unabhängig von buildCoachContext() zusammen und reichte plan_json roh (nur Mo-So-Kürzel, kein Kalenderdatum) an Claude weiter — Claude musste die Wochentag↔Datum-Zuordnung selbst berechnen und verrechnete sich (Samstag-Aktivität wurde als "Freitag" bzw. widersprüchlich als "Samstag-Lauf... am Freitag" bezeichnet). Fix: planJsonWithDates() aus coachContext.ts exportiert und auch im Konflikt-Check-Prompt verwendet.

**Offener Nebenbefund (nicht behoben, zur Beobachtung):** mondayOf() in Dashboard.tsx nutzt für den week_start-String/Session-Gate-Key weiterhin toISOString().slice(0,10) — derselbe UTC-Slice-Bug-Typ wie der ursprüngliche Wochengrenzen-Bug, nur an einer dritten, bisher unangetasteten Stelle. Aktuell kein bekannter sichtbarer Fehler dadurch, aber ein latentes Risiko bei Aktivitäten nahe der lokalen Mitternachtsgrenze (analog zum [LETZTE AKTIVITÄTS-ANALYSE]-Fund vom 2. Juli).

### ✅ Kraftcoach übernahm Lauf-Periodisierungsbegriffe (behoben 3.7.2026)
Kraftanalysen erwähnten fälschlich "Phase 1 — Readaptation" und "Laufeinstieg" — Konzepte aus der Lauf-Saisonplanung, die für das eigenständige Kraft-Ziel (Muskelaufbau/Ästhetik) keinen Sinn ergeben. Fix: showSeasonPhase-Gate (activeSport !== 'strength') entfernt die Lauf-Phase komplett aus dem Kraftcoach-Kontext, ersetzt durch strengthGoalSection (Körperziele + Ästhetik-Prioritäten). Zusätzlich expliziter Blindheits-Satz im KRAFT_COACH_PROMPT als zweite Verteidigungslinie. Gleiches Architektur-Pattern wie die frühere FTP/W-kg-Blindheit beim Laufcoach.

### ✅ Dashboard-Alert zeigte veraltete/irrelevante Recovery-Warnungen (behoben 3.7.2026)
War: Alert-Banner lud alle recovery_required-Einträge der letzten 48h sortiert nach created_at (Extraktionszeitpunkt) statt nach dem Datum der referenzierten Aktivität — wodurch Wochen alte, per Backfill nachträglich analysierte Aktivitäten (z.B. alte Rad-Einschränkungen) einen aktuellen, aber irrelevanten Lauf-Hinweis überdeckten bzw. verfälschten. Fix: Query joint jetzt auf activities.date (via related_activity_id), sortiert danach, limit(1) — nur der zur zeitlich jüngsten Aktivität passende Eintrag wird für den Dashboard-Alert herangezogen. WeeklyPlan.tsx (generatePlan/startReview) bewusst unverändert gelassen (dort sollen mehrere gleichzeitig aktive Restriktionen weiterhin berücksichtigt werden), aber ebenfalls auf den korrekten activities.date-Join umgestellt statt created_at.

### ✅ Sportart-Icon in Dashboard-Aktivitätsliste inkonsistent groß (behoben 3.7.2026)
Icon wurde bei langen, abgeschnittenen Aktivitätsnamen vom Flexbox-Shrink mitverkleinert (fehlendes flex-shrink-0). Fix: flex-shrink-0 ergänzt, Icons jetzt bei jeder Namenslänge einheitlich groß.

### ✅ Wochen-Kennzahlen-Leiste im Wochenplan (implementiert 3.7.2026)
Kompakte Zeile zwischen Phasen-Banner und DayCards: Lauf-km, Rad-km, Kraft-Gesamtgewicht (aus Hevy-Description geparst und summiert) für die jeweils angezeigte Woche. Reagiert auf Wochen-Navigation. "X/Y Einheiten"-Zeile nach Feedback entfernt, nur noch eine Zeile mit größeren Icons/Text (size=20, text-base). Ausgeblendet bei Wochen ganz ohne Aktivität.

### ✅ Mid-Week Feedback: Eintrittspunkt verschoben (implementiert 4.7.2026)
Wie geplant umgesetzt: Feedback-Button komplett aus WeeklyPlan.tsx entfernt, jetzt in ActivityDetail.tsx nebeneinander mit "Roast Me" (je 50%, später auf eine Zeile mit "Neu analysieren" umgestellt, "Roast Me" darunter zentriert). Dashboard-Aktivitätskarten zeigen IconCommentFilled-Indikator via Batch-Query, Tap navigiert zu ActivityDetail.tsx (kein separates Bottom-Sheet auf Dashboard-Ebene, wie final entschieden). Bonus: buildRoastPrompt() nutzt vorhandenes Feedback zusätzlich als Roast-Material.

### ✅ Pagination (implementiert 4.7.2026)
"Mehr laden"-Button im Dashboard, Batch-Größe 10. Wichtiger Diagnose-Fund: Aktivitätsliste lud nie aus Supabase, sondern live von der Strava API (per_page=10, kein page-Parameter) — Supabase dient nur als Write-Cache für Analyse/Matching, nicht als Lesequelle. Pagination daher gegen die Strava API umgesetzt (page-Parameter ergänzt), nicht gegen Supabase — sonst hätte "Mehr laden" bei wenig genutzten/neuen Accounts nur zufällig gecachte Reste gezeigt statt echter Historie. Jede nachgeladene Seite wird wie gehabt über syncActivitiesToSupabase() gecacht, Auto-Analyse läuft automatisch mit.

### ✅ iOS-Auto-Zoom bei Feedback-Freitextfeld (behoben 4.7.2026)
Feedback-Textarea hatte eine Schriftgröße unter 16px — iOS Safari zoomt bei Fokussierung automatisch in solche Felder hinein. Fix: auf text-base (16px) angehoben.

### 🟡 Supabase Auth / Vollständiger Multi-User-Datenschutz
RLS-Policies vorbereitet aber wegen pgBouncer Transaction Mode nicht auf DB-Ebene wirksam. Datenschutz aktuell nur auf Anwendungsebene (WHERE athlete_id = X in jeder Query) — ausreichend für 2-3 vertrauenswürdige Nutzer, kein Schutz vor gezieltem API-Zugriff. Für öffentliches Onboarding: Supabase Auth (JWT-Claims) zwingend erforderlich.
Aufwand: Mittel

### ❌ Body Check-in — implementiert und wieder entfernt (1.7.2026)
Wöchentlicher Foto-Upload (frontal, seitlich, hinten) mit Claude Vision Vergleich wurde vollständig gebaut (Storage, Serverless-Upload/Signed-URLs, Vision-Call, Kraftcoach-Integration), lief beim ersten echten Test aber auf einen Fehler (bare catch-Block verschluckte die eigentliche Fehlerursache). Feature wurde daraufhin bewusst komplett zurückgebaut — inklusive Löschung aller hochgeladenen Fotos, Storage-Bucket, Tabelle und Code.
Falls später erneut angegangen: Lessons Learned — nie einen bare `catch {}` ohne Fehlerprotokollierung verwenden, besonders bei mehrstufigen Upload/Vision-Flows.

### 🟡 Aktivitäts-spezifischer Chat-Thread
Pro Aktivität ein eigener Chat-Thread mit vollem Stream-Kontext. "Warum war meine HF so hoch bei km 8?" direkt aus der Aktivitätsansicht.
Aufwand: Klein

### ✅ Coach-Stile überarbeitet: 4 → 3, echte Ton-Prompts statt Label (implementiert 5.7.2026)
Ursprünglicher Bug gefunden und behoben: coach_persona.style wurde nur als unerklärtes Label ("Coach-Stil: Analytisch") in den Prompt eingesetzt, ohne Verhaltensanweisung — stand zudem im unaufgelösten Widerspruch zum fest verdrahteten ANTWORTFORMAT ("kein leeres Motivationsgeschwätz" widersprach z.B. "Motivierend"). Jetzt: COACH_STYLE_PROMPTS mit drei ausformulierten, mehrsätzigen Instruktionstexten (Motivierend, Analytisch, Drill Sergeant — "Direkt" und "Empathisch" entfernt, da redundant bzw. durch Drill Sergeant abgedeckt). ANTWORTFORMAT präzisiert: Substanz (Zahlen, Ehrlichkeit) ist immer fix, nur der Ton variiert nach Stil. Drill Sergeant hat bewusst harte, militärische Sprache MIT fester Sicherheits-Grenze (nie Angriff auf die Person, weicht bei gemeldeten Schmerzen sofort einem ernsten Ton). Bestehende Alt-Werte ("direkt"/"empathisch") fallen sauber auf Analytisch zurück, kein hartes DB-Update nötig. Stil ist jederzeit im Profil änderbar, wirkt sofort beim nächsten Coach-Call (kein Cache).

### ✅ Roast Me Freischalt-Logik für neue User (implementiert 5.7.2026)
Neue Athleten müssen seit dem Onboarding (athletes.created_at) mindestens 3 eigene Aktivitäten synchronisiert haben, bevor Roast Me nutzbar wird — verhindert dass automatisch mitimportierte historische Alt-Aktivitäten die Freischaltung sofort auslösen. Button bleibt sichtbar aber grau, Klick zeigt Toast mit exakter Restanzahl. Bestandsuser (Markus) unbetroffen, da Schwelle längst erreicht.

### ✅ Push Notifications — tägliche Erinnerung implementiert (20.7.2026)
Konkreter Bedarf (nicht mehr nur Idee): tägliche Erinnerung um 08:00 Uhr an die geplante Aktivität des Tages, perspektivisch zusätzlich eine Bestätigung wenn eine Aktivität von Strava synchronisiert wurde. Relevant geworden durch echten zweiten Nutzer (reine Läuferin) — Erinnerung ist für sie der naheliegendste Mehrwert.

Wie geplant umgesetzt, mit einer Abweichung vom ursprünglichen Fahrplan: kein separates `api/push-subscribe.ts` — die App schreibt ohnehin überall direkt vom Frontend per `supabase-js` in die DB (App-Level-Datenschutz statt wirksamer RLS, siehe unten), eine eigene Serverless Function dafür wäre unnötige Abstraktion gewesen. `enablePushNotifications()`/`disablePushNotifications()` (`src/lib/push.ts`) schreiben/löschen die Subscription direkt in `push_subscriptions`.

Umgesetzt:
1. VAPID-Schlüsselpaar + CRON_SECRET generiert, als Vercel Env Vars zu hinterlegen (VITE_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET, optional VAPID_SUBJECT)
2. `vite-plugin-pwa` von `generateSW` auf `injectManifest` umgestellt — `src/sw.ts` übernimmt Precaching/skipWaiting/clientsClaim/cleanupOutdatedCaches jetzt manuell (vorher automatisch generiert), plus eigener `push`/`notificationclick`-Handler. `sw.ts` bewusst von `tsconfig.json` ausgeschlossen (WebWorker- vs. DOM-Lib-Konflikt), Build separat verifiziert (`dist/sw.js` enthält beide Handler)
3. Tabelle `push_subscriptions` (athlete_id, endpoint UNIQUE, p256dh, auth) — ein Athlet kann mehrere Geräte haben
4. `Profile.tsx`: eigene Sektion "Benachrichtigungen" mit Button "Erinnerungen aktivieren" — zeigt je nach `getPushSupport()`-Status unterschiedliche UI (aktivierbar / iOS-Installationsanleitung / blockiert), damit der Button nie lautlos wirkungslos ist
5. `api/send-daily-reminder.ts`: liest für jeden Athleten mit Subscription den heutigen Wochentag aus dem aktuellen Wochenplan (neueste Version), sendet bei Nicht-Ruhetag eine Push via `web-push`; entfernt Subscriptions bei HTTP 404/410 automatisch. "Heute" und Wochenstart werden explizit über `Intl.DateTimeFormat(..., { timeZone: 'Europe/Vienna' })` berechnet, nicht über `new Date().getDay()` — die Vercel-Cron-Runtime läuft in UTC, ein naiver Ansatz hätte denselben UTC-Slice-Bug-Typ reproduziert wie mehrfach in diesem Dokument
6. Vercel Cron (`vercel.json`) — zwei Slots statt einem einzelnen Zeitpunkt (Anpassung nach dem ersten Live-Test, 20.7.2026): `?slot=morning` (`"0 5 * * *"` = 07:00 CEST) sendet immer bei Nicht-Ruhetag, `?slot=evening` (`"0 15 * * *"` = 17:00 CEST) zusätzlich nur, wenn für den Athleten noch keine Strava-Aktivität "heute" erfasst wurde (eigene `activities`-Abfrage mit expliziten Europe/Vienna-Tagesgrenzen, via `Intl` `longOffset` DST-sicher berechnet statt hartcodiertem Offset). Keine automatische DST-Anpassung der Cron-Uhrzeiten selbst, weiterhin bekannte Einschränkung dieser ersten Version
7. `CRON_SECRET` schützt den Endpoint (Vercel setzt den `Authorization`-Header automatisch, wenn die Env Var diesen exakten Namen trägt)

Zusätzlich zum ursprünglichen Plan: `syncPushSubscription()` läuft still bei jedem App-Start (App.tsx Layout, sobald Permission bereits erteilt ist) und fängt ein bekanntes iOS-Verhalten ab — Push-Subscriptions können nach längerer Inaktivität serverseitig ungültig werden, ohne dass Permission-State oder App etwas davon merken.

Bug beim ersten Live-Test gefunden und behoben (20.7.2026): `push_subscriptions` hatte RLS aktiviert, aber keine Policy — Postgres blockierte den Anon-Key-Insert lautlos (kein Fehler von `supabase-js`, `saveSubscription()` prüfte den `error`-Rückgabewert des Upserts nicht), UI zeigte trotzdem "✓ Erinnerungen aktiviert". Fix: dieselbe `"... : open for now"`-Policy wie bei allen anderen Tabellen ergänzt, `saveSubscription()` wirft jetzt bei einem Fehler statt ihn zu verschlucken.

Plattform-Realität (unverändert wie geplant): Android zuverlässig (Chrome nativ), iOS erfordert iOS 16.4+ UND zum Home-Bildschirm hinzugefügte PWA (`display-mode: standalone`) — im normalen Safari-Tab technisch nicht möglich, `getPushSupport()` erkennt das und zeigt in Profile.tsx eine Anleitung statt eines toten Buttons. Verifiziert per echtem End-to-End-Test auf Markus' iPhone (20.7.2026): Aktivierung, Zustellung beider Slots. Die iOS-Systemzeile mit dem App-Namen unter der Notification ("PeakForm") ist von Apple vorgegeben und nicht unterdrückbar. Apple-Watch-Mirroring der Web-Push-Benachrichtigung griff im Test nicht — vermutlich Plattform-Limitierung (Web Push läuft über Safaris eigenen Push-Kanal, nicht über den regulären APNs-Pfad einer nativen App, über den Watch-Mirroring normalerweise läuft), nicht weiter untersucht.

Noch offen: echter End-to-End-Test auf physischem iPhone/Android (Homescreen installieren → Permission erlauben → Push tatsächlich empfangen) — lässt sich nicht vollständig im Dev-Setup simulieren. Sync-Bestätigungs-Push (bei neu importierter Strava-Aktivität) bewusst nicht in dieser ersten Runde.

Aufwand: Mittel — umgesetzt.

### ✅ Wochenreview und Plan-Generierung entkoppelt (6.7.2026)
War: startReview() erzeugte immer BEIDES gleichzeitig — Bewertung der abgelaufenen Woche UND einen kompletten neuen Plan für die Folgewoche. Jetzt: Review ist reine Bewertungs-/Journal-Funktion (nur `{review: string}`, keine Plan-Constraints mehr im Prompt), review_notes/review_user_input landen als neue Version der BEWERTETEN Woche selbst (nicht mehr auf der Folgewoche) — löst auch das vorherige "wo gehört das Review eigentlich hin"-Verwirrung. "Plan generieren" ist danach ein komplett eigenständiger, manuell ausgelöster Button für die im Navigator angezeigte Woche, nie mehr implizit durch ein Review ausgelöst.

### ✅ Wochenreview-Ergebnis-Karte + persistenter User-Freitext (implementiert 6.7.2026)
Eigener Freitext-Input beim Review wurde bisher gar nicht gespeichert (nur ephemer, ging bei Reload/Wochenwechsel verloren), Coach-Bewertung (review_notes) wurde nirgends in der UI angezeigt — nur im Hintergrund als Coach-Kontext genutzt. Neue Spalte review_user_input + aufklappbare WeeklyReviewCard (immer ausgeklappt beim Laden) zeigen jetzt beides. Layout-Korrektur (8.7.): Review-Sektion sitzt jetzt chronologisch korrekt NACH den DayCards, nicht mehr direkt unter der Wochennavigation.

### ✅ "Plan generieren" für abgelaufene Wochen entfernt (implementiert 8.7.2026)
isPastWeek-Check (monday < aktuelle Woche) — Button entfällt komplett für vergangene Wochen, unabhängig davon ob bereits ein Plan existiert (verhindert sowohl Erst- als auch Neu-Generierung rückwirkend). Statt Button: neutraler Hinweistext "Für diese Woche wurde kein Plan erstellt" falls keiner existiert.

### ✅ Fehlende Uhrzeit/Tageszeit in Coach-Analysen (behoben 8.7.2026)
Konkret entdeckt: Coach behauptete "Krafttraining am Morgen", tatsächlich war es der Vorabend — Root Cause: Claude bekam nie Uhrzeit oder Tag-Relation (heute/gestern), nur ein rohes Datum, und musste die Differenz selbst berechnen (mit Fehlern). Neue Helper toLocalWeekdayDateTimeStr() + relativeDayLabel() (bewusst ohne Intl-API, konsistent zum bestehenden Lokalzeit-Stil), zusätzlich explizite Anti-Halluzinations-Regel im System-Prompt ("nutze nur explizit gegebene Zeit-/Tag-Angaben, erfinde nichts selbst").

### ✅ On-load Recovery-Check läuft bei jedem Öffnen erneut (behoben 8.7.2026, Commit 8e01ce4)
Diagnose bestätigt: bei Aktivitäten OHNE erkannte Erholungsrestriktion (die Mehrheit) hinterließ has_restriction:false keinen persistenten Marker — der Mini-Claude-Call (max_tokens:150) feuerte dadurch bei jedem einzelnen Seitenaufruf erneut, unnötige wiederholte API-Calls/Kosten (kein sichtbarer Content-Fehler). Fix: neue Spalte activities.recovery_checked (Boolean), gesetzt sobald der Check einmal erfolgreich durchgelaufen ist, unabhängig vom Ergebnis — On-load-Check vereinfacht auf if (act.claude_analysis && !act.recovery_checked). Bestandsaktivitäten bekamen dadurch einmalig noch einen Nachhol-Check, danach nie wieder. Bei einem Fehler im Claude-Call bleibt recovery_checked bewusst false, damit der Check beim nächsten Laden erneut versucht wird.

### 🐛 Kraft-Workout-Label wird nie gegen echten Aktivitätsnamen validiert (offen, entdeckt 8.7.2026)
matchActivityToDay() prüft für Kraft-Tage nur den Sportart-Typ (WeightTraining), nie ob die geplante Workout-Nummer (I/II/III) zur tatsächlich absolvierten passt — beide Strings (Plan-Label vs. echter Aktivitätsname) sind komplett unabhängig und werden nie gegeneinander geprüft. Führte am 6.7. zu einem stillen Auseinanderlaufen (Mi zeigte "Workout II" geplant, aber "✓ Workout I" absolviert) — ausgelöst durch ein einmaliges Datenintegritäts-Ereignis (siehe unten), aber der strukturelle Gap bleibt latent bestehen und kann jederzeit wieder auftreten sobald Plan-Rotation und reale Reihenfolge divergieren.
Vorgeschlagener Fix (noch nicht umgesetzt): bei Mismatch zusätzlicher Hinweis "⚠ Geplant war {label}, absolviert wurde {activity.name}" statt stiller ✓-Zeile — nicht blockierend, nur Transparenz.
Aufwand: Klein

### ✅ Datenintegritäts-Vorfall: Plan einer Woche versehentlich in eine andere geschrieben (korrigiert 8.7.2026, kein Code-Fix)
Durch einen Deploy-Timing-Zufall (Stale-Tab mit altem JS-Bundle, 6 Minuten nach dem Entkopplungs-Commit) wurde der komplette plan_json der aktuellen Woche (KW 07-06) byte-identisch in die Historie der Vorwoche (KW 06-29) geschrieben — inkl. change_reason im alten, längst abgelösten Format. Betraf nur einen einzelnen historischen Datensatz, nicht den aktiven Code-Pfad (der fehlerhafte Schreibpfad existiert nach der Entkopplung nicht mehr). Per gezieltem SQL-INSERT auf Basis der letzten unkontaminierten Version (v18) korrigiert — reine Datenkorrektur, kein Code-Fix nötig.

### ✅ Manuelles Verschieben von Trainingstagen (implementiert 4.7.2026)
Ursprüngliche Idee "fixe Sperrtage im Profil" verworfen — Konflikte (Wetter, spontane Termine) sind per Definition unvorhersehbar, eine feste Regel ("nie montags") hätte das eigentliche Problem nicht gelöst. Stattdessen direkt die Phase-2-Idee umgesetzt: manuelles Verschieben im laufenden Wochenplan ist jetzt die Hauptlösung.

Finales Konzept umgesetzt: Drag-and-Drop zum Tauschen zweier Tage (swapDays(), nutzt bereits installiertes @dnd-kit wie beim Ästhetik-Ranking im Profil, Commit 723fc47) + Long-Press-Kontextmenü (500ms, 8px Bewegungstoleranz — "Als Ruhetag markieren", "Verschieben nach...", "Details anzeigen") als Fallback für alle, die Drag-Gesten vermeiden wollen. Client-seitige, nicht-blockierende Konflikt-Prüfung (checkPlanConflicts(), kein Claude-Call — mechanische Prüfung derselben harten Regeln, die der Coach beim Planen bekommt: keine zwei intensiven Tage nebeneinander, kein Kraft direkt vor intensiver Ausdauer). Jede Änderung erzeugt eine neue weekly_plans-Version (INSERT, wie gehabt). Follow-up-Fix am selben Tag (Commit c2f8c24): Drag-Sensor auf delay+tolerance umgestellt, expliziter Griff statt ganzer Karte. Weiterer Follow-up-Fix (8.7.2026, Commit 8cb388d): Long-Press auf der Karte löste auf iOS zusätzlich das native Textauswahl-Menü ("Kopieren | Nachschlagen") über dem eigenen Kontextmenü aus — behoben via `select-none` + `WebkitTouchCallout: 'none'` auf der DayCard.

### ✅ "Zurück"-Button in ActivityDetail.tsx führte immer zum Dashboard statt zur echten Vorseite (behoben 12.7.2026)
War als `<Link to="/dashboard">` hart verdrahtet statt echtes History-Back — z. B. vom Coach-Chat oder aus dem Wochenplan kommend landete man beim Zurückgehen trotzdem immer auf dem Dashboard. Fix: `navigate(-1)` (react-router), aber nur wenn tatsächlich SPA-eigene History existiert (`window.history.state?.idx > 0`) — bei Deep-Links (z. B. direkter URL-Aufruf, Push-Benachrichtigung) ohne vorherige App-Navigation bleibt der Fallback auf `/dashboard`, da `navigate(-1)` sonst aus der App heraus navigiert hätte. Nebenbei aufgefallen: der Dashboard-Sportart-Filter (`filter`-State) war reiner `useState` und wurde beim Unmount/Remount der Route ohnehin gelöscht — `navigate(-1)` allein hätte den Filter also nicht gerettet. Deshalb zusätzlich in `sessionStorage` (`dashboard_filter`) persistiert, damit "Dashboard mit Filter → Aktivität öffnen → Zurück" den Filter jetzt tatsächlich erhält.

### ✅ Swipe-Navigation zwischen BottomNav-Tabs (implementiert 13.7.2026)
Horizontales Wischen wechselt auf Mobile zwischen den sichtbaren BottomNav-Tabs (links → nächster, rechts → vorheriger, kein Wrap-Around an den Rändern). Tab-Reihenfolge/-Sichtbarkeit war bisher inline in `BottomNav.tsx` berechnet — für die Geste in `useVisibleTabs()` extrahiert, damit beide dieselbe gefilterte Liste nutzen und bei unterschiedlichen Feature-Flags zwischen Athleten nicht auseinanderlaufen können. Neuer Hook `useTabSwipeNavigation()` (native `touchstart`/`touchend`, keine neue Abhängigkeit) ist im Layout-Wrapper registriert, aktiviert sich aber nur, wenn der aktuelle Pfad tatsächlich einem der 5 Haupt-Tabs entspricht — auf `/activity/:id`, `/onboarding`, `/auth/callback` und `/` bleibt er automatisch inert. Schwelle: horizontale Distanz > 60px und |Δx| > 2×|Δy| (verhindert Fehlauslösung bei vertikalem Scrollen). Kollisionsvermeidung mit WeeklyPlan: DayCard trägt `data-swipe-ignore`, sodass Gesten, die auf einer Karte oder deren Drag-Griff beginnen (dnd-kit-Drag, Long-Press-Kontextmenü), die Swipe-Erkennung komplett überspringen.

### ✅ Coach-Chat-Verlauf ging bei PWA-Reinstall auf iOS verloren (behoben 13.7.2026)
Ursache: `thread_id` in Chat.tsx kam aus `localStorage.coach_thread_id` (`crypto.randomUUID()` beim ersten Besuch). iOS behandelt das Entfernen + Neuhinzufügen des Home-Bildschirm-Icons wie eine Neuinstallation und leert dabei den lokalen Speicher der PWA — dadurch entstand ein neuer, leerer `thread_id`, alte Nachrichten blieben unter dem alten `thread_id` in `chat_messages` bestehen, waren für die UI aber nicht mehr erreichbar. Fix: `thread_id` ist jetzt `athlete.id` statt einer Zufalls-UUID — es gibt ohnehin nur einen einzigen `chat_type='global'`-Thread pro Athlet, eine zusätzliche ID brachte keinen Mehrwert, machte den Verlauf aber fragil gegenüber `localStorage`-Verlust. Bestehende verwaiste Threads (7 Fragmente bei Markus, entstanden durch frühere Reinstalls, insgesamt 30 Nachrichten) per einmaliger SQL-Migration (`UPDATE chat_messages SET thread_id = athlete_id WHERE thread_id != athlete_id`) pro Athlet sauber getrennt zusammengeführt — vor/nach-Verifikation bestätigte keine Vermischung zwischen den beiden echten Athleten-Accounts. Der "Neu"-Button leert seitdem nur noch die lokale Ansicht statt einen neuen Thread anzulegen; der Verlauf bleibt in Supabase erhalten und erscheint nach Reload wieder.

### 🟢 Kraftcoach-Ästhetik-Bewertung (Phase D)
Automatisches Übungs-Matching: Kraftcoach identifiziert Lücken in Workout I/II/III und schlägt Ersetzungen vor basierend auf Ästhetik-Prioritäten und Equipment.
Aufwand: Mittel

### 🟢 CTL/ATL/TSB Fitness-Kurve
Chronische Trainingsbelastung, Akute Trainingsbelastung, Training Stress Balance aus TSS-Werten. Zeigt wann Peak-Form für Wettkampf erreicht wird.
Aufwand: Mittel

---

## 2. Coach-System Erweiterungen

### ✅ Automatische Analyse neuer Aktivitäten (implementiert 3.7.2026, besser als ursprünglich geplant)
Ursprünglich geplant als reaktiver Schutz nur vor Plan-Generierung/Review. Stattdessen proaktiv gelöst: jede neu von Strava importierte Aktivität wird automatisch analysiert (inkl. Recovery-Extraction) — kein manueller Klick auf "Analysieren" mehr nötig, Button heißt jetzt "Neu analysieren" für erneute Analyse. Analyse-Logik zentral in src/lib/activityAnalysis.ts extrahiert. Zusätzliches Sicherheitsnetz beim Plan generieren/Review (closeOutstandingAnalyses()) fängt verbleibende unanalysierte Aktivitäten trotzdem ab. Damit ist die ursprüngliche Sorge (Sonntagseinheit wird nicht geöffnet, Recovery-Check greift nicht) strukturell komplett gelöst — relevant besonders für die zweite Person, die nicht dieselbe manuelle Analyse-Disziplin hat wie Markus.

### 🟡 Dynamische Pace-Kalibrierung
Statt statischer 5k Bestzeit berechnet der Coach die aktuelle Z2-Pace aus den letzten 3-4 echten Läufen (tatsächliche Pace bei HF 127-148 bpm). Erst implementieren wenn 3-4 echte Läufe in der Datenbank sind.
Aufwand: Klein

### 🟡 Chat-Kontext Erweiterung
Aktuell nur letzte 10 Chat-Nachrichten. Längere Gespräche verlieren ihren Faden. Optionen: mehr Nachrichten (20-30), komprimierte Zusammenfassung als Kontext, oder themen-basierte Segmentierung.
Aufwand: Klein bis Mittel

### 🟢 Langzeit-Trainingshistorie
Aktuell nur 4-8 Wochen Kontext. Monatliche Zusammenfassungen automatisch generieren und als Langzeitgedächtnis speichern.
Aufwand: Mittel

---

## 3. UX & Mobile

### 🟡 Admin-Panel für Feature-Flags
Einfacher passwortgeschützter Screen in der App um User und Feature-Flags zu verwalten statt manuell in Supabase. Sinnvoll ab 3-4 Usern.
Aufwand: Mittel

### 🟢 Leistungsentwicklung Dashboard
Eigener Screen mit Langzeit-Trends: FTP-Verlauf, 5k Bestzeit-Entwicklung, wöchentliches Volumen (km + TSS), Verhältnis Laufen/Rad/Kraft.
Aufwand: Mittel

### 🟢 Strava-Bestzeiten Import
Automatisch 5k, 10k, HM Bestzeiten aus Strava-Aktivitäten extrahieren statt manuell einzutragen.
Aufwand: Klein (Strava Personal Records API)

### 🟢 Dark/Light Mode Toggle
App ist aktuell nur Dark Mode.
Aufwand: Mittel

### 🟢 Offline-Modus
Gecachte Daten (letzter Plan, letzte Aktivitäten) ohne Internetverbindung anzeigen.
Aufwand: Mittel

---

## 4. Statistik & Automatisierung

### 🟡 Statistik-Screen: Grafische Trainingsübersicht
Eigener Screen (neuer Tab oder von Dashboard erreichbar) mit wöchentlichen Trainingsdaten pro Sportart — letzte 8 Wochen als Recharts-Diagramme.

Laufen: wöchentliche km (Balkendiagramm), Pace-Trend, Gesamtzeit, HF-Zonen-Verteilung (Z1–Z5 als Stacked Bar).
Radfahren: wöchentliche km + Höhenmeter, TSS-Verlauf, NP-Trend, Gesamtzeit.
Krafttraining: Anzahl Einheiten pro Woche, Gesamtzeit, Workout I/II/III Verteilung.
Gesamt: Trainingszeit aller Sportarten gestapelt, Verhältnis Laufen/Rad/Kraft über Zeit.

Datenquelle: activities Tabelle in Supabase — alle Daten bereits vorhanden, nur Aggregierung und Darstellung fehlt.
Aufwand: Mittel

### 🟡 Automatische Wochenzusammenfassung durch Coach
Nach Wochenabschluss (Montag der neuen Woche) generiert der Coach automatisch einen kurzen Kommentar zu den Statistiken — ohne manuellen Trigger.

Ablauf: Strava-Sync erkennt neue Woche → Claude-Call mit Wochendaten → Kurzkommentar (max 150 Tokens) in Supabase → erscheint im Statistik-Screen oder Dashboard.
Unterschied zum Review: kein Freitext-Input, rein datengetrieben, kein neuer Plan.
Aufwand: Klein bis Mittel

### 🟡 Halbautomatische Wochenplan-Erstellung
Vollautomatisch bewusst nicht umgesetzt — Coach braucht subjektives Feedback für gute Planung.

Halbautomatischer Flow: User öffnet App (eigenständig, kein automatischer Trigger) → sieht Wochen-Statistik + Coach-Kurzkommentar → füllt kurz Freitext aus → tippt "Plan generieren".
Voraussetzung: Statistik-Screen. (Push-Notification-Trigger entfernt, siehe unten)
Aufwand: Klein (wenn Statistik-Screen vorhanden)

---

### ✅ Roast Me (implementiert 3.7.2026 — finale Form nach mehreren Iterationen)
Ursprüngliche Idee (Spaß-Modus, 3 Presets: Sarkastisch/Roast/Sexy) wurde gebaut, getestet und dann bewusst vereinfacht: EIN Modus "Roast Me" statt drei — bitterböser, South-Park-artiger Ton, sportart-spezifische Zahlen (Pace/HF beim Laufen, Watt/Trittfrequenz beim Rad, Gewicht/Wiederholungen/Muskelgruppen bei Kraft), personalisiert mit Namen. Einzelner Flammen-Button (🔥 Roast Me 🔥, orange→rot-Gradient) unterhalb der ernsten KI-Analyse, Ergebnis-Card im Flammen-Look, Auto-Scroll zum Ergebnis nach Generierung.

Wichtige Architektur-Entscheidung (wie ursprünglich geplant): komplett isoliert von buildCoachContext()/coach_decisions — rein ephemer im React-State, kein Einfluss auf zukünftige ernsthafte Coaching-Entscheidungen.

Iterationsverlauf (zur Nachvollziehbarkeit): Sexy-Modus wurde in mehreren Schritten deutlicher/zweideutiger gemacht, dann zusammen mit Sarkastisch komplett gestrichen zugunsten des einen fokussierten Roast-Modus — einfacher, konsistenter, weniger Entscheidungsparalyse beim Nutzen.

Kosten: pro Roast ein zusätzlicher Sonnet-Call (~$0.01), vernachlässigbar.

### ✅ Erkenntnisse aus Aktivitätsbewertung wirken jetzt auf den bestehenden Wochenplan (behoben 2.7.2026 Abend, Commit ec362aa)
War: Coach-Erkenntnisse (z.B. Erholungsempfehlung) landeten zwar in coach_decisions, veränderten aber den laufenden Wochenplan nicht automatisch/sichtbar — erst beim nächsten manuellen "Plan generieren"/"Wochenreview".

Fix — zwei Lücken im bereits bestehenden Echtzeit-Alert-Mechanismus (Kapitel 18.3) geschlossen:
1. "Plan anpassen" gab bisher nur Claude-Freitext ins Modal aus, ohne Persistierung. Fordert jetzt strukturiertes Plan-JSON an (gleiches Format wie generatePlan()), speichert als neue weekly_plans-Version (INSERT, version++, change_reason) + coach_decisions-Eintrag (plan_adjusted). Modal zeigt "Plan aktualisiert ✓" mit Link zum Wochenplan.
2. Der Konflikt-Check-Claude-Call lud bisher nur die neueste Strava-Aktivität. Lädt jetzt zusätzlich recovery_required-Einträge der letzten 48h — Gate-Bedingung erweitert von plan && latestAct auf plan && (latestAct || hasRecovery), Alert kann jetzt auch ohne neue Strava-Aktivität ausgelöst werden.

Lösungsrichtung wie vorab entschieden: sichtbarer Hinweis + bewusste Bestätigung (kein stiller Auto-Umbau) — Amber-Banner mit "Plan anpassen"-Button, User bestätigt aktiv, neue Version wird nachvollziehbar in der Historie gespeichert.

Noch zu verifizieren: voller Live-Flow gegen echte Supabase-Daten/Strava-Sync wurde noch nicht getestet (lief nicht gegen echten Account während der Implementierung).

## 5. Daten & Integrationen

### 💡 Wetterintegration
Wetterdaten (Temperatur, Wind, Regen) in Aktivitätsanalyse einbeziehen. "HF war heute höher als sonst" könnte an 28°C liegen, nicht an Übertraining. Open-Meteo API (kostenlos).
Aufwand: Klein

### 💡 Apple Health / Garmin Connect
HRV und Schlafqualität als Erholungs-Indikatoren. Coach könnte "schlechte Nacht + hohe HRV-Abweichung = heute locker trainieren" automatisch erkennen.
Aufwand: Groß

### 💡 Strava-Segmente
Bestzeiten auf häufig gefahrenen Segmenten tracken — zeigt Leistungsentwicklung auf bekannten Strecken.
Aufwand: Mittel

### 💡 Ernährungsempfehlungen
Coach gibt Empfehlungen basierend auf Trainingsbelastung (z.B. Carb-Loading vor hartem Training). Datenbasis (Gewicht, Ziele) bereits vorhanden.
Aufwand: Klein (nur Prompt-Erweiterung)

---

## 6. Soziale Features

### 💡 Geteilte Ziele / Challenges
Zwei User können dasselbe Event als Ziel setzen und gegenseitig Trainingsfortschritt sehen.
Aufwand: Mittel bis Groß

### 💡 Coach-Modus
Ein User (Markus) sieht die Daten aller seiner Athleten — Coach-Dashboard mit Übersicht über alle aktiven User. Sinnvoll ab 5+ Athleten.
Aufwand: Groß (komplett neues Rollenkonzept)

### 💡 Tenniscoach / Schwimmcoach
Weitere Spezialcoaches wenn entsprechende Sportarten hinzugefügt werden. Tennis bereits im Gespräch.
Aufwand: Klein (nur neuer Prompt, Coach-Routing erweitern)

---

## 7. Technische Schulden

### 💡 mondayOf() in Dashboard.tsx nutzt weiterhin toISOString().slice(0,10)
Entdeckt als Nebenbefund beim Dashboard-Alert-Datumsfix (4.7.2026). Dritte Stelle mit demselben UTC-Slice-Bug-Typ wie der ursprüngliche Wochengrenzen-Bug (30.6.) — betrifft hier nur den week_start-String für den Session-Gate-Key des Echtzeit-Alerts, nicht die Plan-Zuordnung selbst. Aktuell kein bekannter sichtbarer Fehler, aber latentes Risiko bei Aktivitäten nahe der lokalen Mitternachtsgrenze. Sollte bei Gelegenheit auf getISOMonday()/toLocalDateString() (dateUtils.ts) vereinheitlicht werden, analog zu den bereits behobenen Stellen.
Aufwand: Klein


### ✅ Wochengrenzen-Bug (behoben 30.6.2026)
ISO 8601 Wochenstart (Montag) implementiert via dateUtils.ts. Supabase-Migration: alle week_start Sonntage um +1 Tag korrigiert. Fallback-Query in WeeklyPlan.tsx bis Ende Juli 2026 aktiv.

### 🟡 Error Handling
Fehlgeschlagene Claude-Calls, Strava-API-Fehler und Supabase-Fehler nur in Console geloggt. User sieht bei Fehlern nichts. Toast-Notifications für häufige Fehlertypen.
Aufwand: Klein

### 🟢 Unit Tests
Tests für kritische Funktionen: matchActivityToDay(), buildCoachContext(), calculateHRZones(), Constraint-Validierung.
Aufwand: Mittel

### 💡 iOS Safari Service-Worker-Cache-Verzögerung (breiteres Muster)
Ursprünglich nur beim Splash-Screen beobachtet (PWA am Homescreen zeigte alten Code), inzwischen auch bei normalen Bugfixes reproduziert: Activity-ID-Mismatch-Fix funktionierte sofort am Desktop, auf iPhone Safari (auch als reiner Browser-Link, nicht nur PWA) erst nach manuellem "Verlauf und Websitedaten löschen". Ursache: iOS Service Worker Cache hält alte JS-Bundles länger vor als Desktop-Browser.
Teilfix 1.7.2026: skipWaiting/clientsClaim/cleanupOutdatedCaches in vite-plugin-pwa ergänzt + manueller Update-Check beim App-Start — reduziert die Verzögerung, eliminiert sie aber laut Erfahrungswerten nicht vollständig (iOS bleibt eigenwillig).
Workaround falls ein Fix nach Deploy nicht ankommt: Safari-Cache manuell leeren.
Aufwand: Mittel — laufend beobachten, niedrige Priorität solange der Workaround zuverlässig funktioniert.

### 🟢 TypeScript Strict Mode
Strict Mode aktivieren und alle Type-Errors beheben.
Aufwand: Mittel

---

## Priorisierungs-Matrix

| Feature | Nutzen | Aufwand | Priorität |
|---|---|---|---|
| ✅ Wochengrenzen-Bug | Behoben | — | 30.6.2026 |
| ✅ Kraftcoach Lauf-Begriffe | Behoben | — | 3.7.2026 |
| ✅ Dashboard-Alert veraltete Warnungen | Behoben | — | 3.7.2026 |
| ✅ Icon-Größe Aktivitätsliste | Behoben | — | 3.7.2026 |
| ✅ Wochen-Kennzahlen-Leiste | Umgesetzt | — | 3.7.2026 |
| ✅ Roast Me | Umgesetzt | — | 3.7.2026 |
| ✅ Extra-Status Ruhetage | Umgesetzt | — | 4.7.2026 |
| ✅ SPORT_DISPLAY.other Fallback | Behoben | — | 4.7.2026 |
| ✅ Dashboard-Alert falscher Wochentag | Behoben | — | 4.7.2026 |
| 💡 mondayOf() UTC-Slice-Risiko | Niedrig | Klein | 💡 Beobachten |
| ✅ Pagination | Umgesetzt | — | 4.7.2026 |
| ✅ iOS Auto-Zoom Feedback-Feld | Behoben | — | 4.7.2026 |
| ✅ Coach-Stile überarbeitet | Umgesetzt | — | 5.7.2026 |
| ✅ Wochenreview/Plan-Generierung entkoppelt | Umgesetzt | — | 6.7.2026 |
| ✅ Wochenreview-Ergebnis-Karte | Umgesetzt | — | 6.7.2026 |
| ✅ Plan generieren für Altwochen entfernt | Behoben | — | 8.7.2026 |
| ✅ Uhrzeit/Tageszeit-Halluzination | Behoben | — | 8.7.2026 |
| ✅ Datenintegritäts-Vorfall korrigiert | Behoben | — | 8.7.2026 |
| 🐛 Kraft-Workout-Label-Validierung | Mittel | Klein | Offen |
| ✅ recovery_checked Cache-Fix | Behoben | — | 8.7.2026 |
| ✅ Manuelles Verschieben von Trainingstagen | Umgesetzt | — | 4.7.2026 |
| ✅ Roast Me Freischalt-Logik | Umgesetzt | — | 5.7.2026 |
| ✅ Push Notifications | Umgesetzt | — | 20.7.2026 |
| ✅ OAuth CSRF-Schutz | Behoben | — | 1.7.2026 |
| ✅ Multi-User Session-Restore | Behoben | — | 1.7.2026 |
| Supabase Auth (vollständiger Datenschutz) | Sicherheit | Mittel | 🟡 Vor öffentlichem Onboarding |
| ✅ Mid-Week Check-in | Behoben | — | 2.7.2026 |
| ✅ Dynamische Pace-Kalibrierung | Umgesetzt | — | 5.7.2026 |
| ✅ Onboarding-Flow | Behoben | — | 1.7.2026 |
| ✅ Automatische Aktivitäts-Analyse | Behoben | — | 3.7.2026 |
| ✅ Activity-ID-Mismatch (Plan→Detail) | Behoben | — | 2.7.2026 |
| ✅ Datums-Bug Coach-Analysen (3 Fundstellen) | Behoben | — | 2.7.2026 |
| Body Check-in | — | — | ❌ Entfernt |
| Error Handling | Mittel | Klein | 🟡 Bald |
| Statistik-Screen | Hoch | Mittel | 🟡 Bald |
| Automatische Wochenzusammenfassung | Mittel | Mittel | 🟡 Bald |
| Halbautomatischer Wochenplan | Mittel | Klein | 🟡 Nach Push+Statistik |
| CTL/ATL/TSB Kurve | Mittel | Mittel | 🟢 Später |
| Leistungsentwicklung Dashboard | Mittel | Mittel | 🟢 Später |
| Strava-Bestzeiten Import | Mittel | Klein | 🟢 Später |
| Wetterintegration | Mittel | Klein | 💡 Evaluieren |
| Coach-Modus | Hoch | Groß | 💡 Zukunft |
| iOS Safari Service-Worker-Cache | Niedrig | Mittel | 💡 Laufend beobachten |
| Apple Health / Garmin | Hoch | Groß | 💡 Zukunft |
| ✅ "Zurück"-Button ActivityDetail (Hard-Redirect) | Behoben | — | 12.7.2026 |
