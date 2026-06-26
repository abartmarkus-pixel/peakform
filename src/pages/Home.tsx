import { STRAVA_AUTH_URL } from '../lib/strava'

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-5xl font-bold text-brand-500 tracking-tight">PeakForm</h1>
        <p className="mt-3 text-slate-400 text-lg">Dein KI-Trainingscoach powered by Strava</p>
      </div>

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

      <p className="text-slate-500 text-sm max-w-sm text-center">
        PeakForm liest deine Trainingsaktivitäten und erstellt KI-basierte Analysen
        mit Claude von Anthropic.
      </p>
    </div>
  )
}
