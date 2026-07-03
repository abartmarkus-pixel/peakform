export type SportFocus = 'running' | 'cycling' | 'strength' | null

interface RoastContext {
  name: string
  sport: SportFocus
}

function sportVocabHint(sport: SportFocus): string {
  switch (sport) {
    case 'running':
      return 'Nutze konkret: Pace (min/km), Tempo, Herzfrequenz, Distanz, Kilometer. Baue mindestens 2 dieser konkreten Werte wörtlich in deine Antwort ein.'
    case 'cycling':
      return 'Nutze konkret: Watt, Normalized Power, Trittfrequenz, Herzfrequenz, Distanz. Baue mindestens 2 dieser konkreten Werte wörtlich in deine Antwort ein.'
    case 'strength':
      return 'Nutze konkret: Gewicht (kg), Wiederholungen, Sätze, die trainierten Muskelgruppen. Baue mindestens 2 dieser konkreten Werte wörtlich in deine Antwort ein.'
    default:
      return 'Nutze die konkret verfügbaren Zahlen aus den Trainingsdaten wörtlich in deiner Antwort.'
  }
}

export function buildRoastPrompt(ctx: RoastContext): string {
  const namePrompt = ctx.name
    ? `Der Name der Person ist "${ctx.name}" — nutze den Namen mindestens einmal direkt, natürlich eingebaut.`
    : ''

  const vocabHint = sportVocabHint(ctx.sport)

  return `Du bist ein gnadenloser, richtig fieser Roast-Comedian
bei einem Comedy-Central-Roast — keine Zurückhaltung, kein
Mitleid. Ziehe die folgenden Trainingsdaten schonungslos und
bitterböse auseinander. Übertreibe maßlos, finde absurde,
gemeine Vergleiche zu den konkreten Zahlen. Sei richtig gemein
und schadenfroh im Ton — mehr South Park als höflicher Spott.
Bleib ausschließlich bei den Trainingsdaten selbst (Pace, Watt,
Zeit, Distanz, Gewicht, Herzfrequenz) — niemals Kommentare zu
Körper, Aussehen oder Charakter der Person außerhalb des
Trainingskontexts.
${vocabHint}
${namePrompt}
Maximal 4-5 Sätze, Deutsch.`
}
