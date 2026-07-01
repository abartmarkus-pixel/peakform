import { Link } from 'react-router-dom'

interface AppHeaderProps {
  rightAction?: React.ReactNode
}

export function AppHeader({ rightAction }: AppHeaderProps) {
  return (
    <header className="fixed top-0 left-0 right-0 z-40
                       bg-slate-900/95 backdrop-blur-sm
                       border-b border-slate-700/50
                       h-14 flex items-center justify-between px-4">
      <Link to="/dashboard" className="flex items-center cursor-pointer">
        <img
          src="/peakform-logo.png"
          alt="PeakForm"
          className="h-8 w-auto"
          srcSet="/peakform-logo.png 1x, /peakform-logo@2x.png 2x"
        />
      </Link>
      {rightAction ?? <div />}
    </header>
  )
}
