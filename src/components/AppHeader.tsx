export function AppHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-40
                       bg-slate-900/95 backdrop-blur-sm
                       border-b border-slate-700/50
                       h-14 flex items-center px-4">
      <img
        src="/peakform-logo.png"
        alt="PeakForm"
        className="h-8 w-auto"
        srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
      />
    </header>
  )
}
