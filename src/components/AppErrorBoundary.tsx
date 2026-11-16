import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unexpected rendering error';
    return { hasError: true, message };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-[#080B10] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-xl bg-[#0D131F] border border-rose-500/50 p-6 space-y-4">
            <div className="text-xs font-mono uppercase tracking-wider text-rose-400 font-semibold">
              GRIDSLURP // DISPLAY RECOVERY
            </div>
            <h1 className="text-xl font-bold text-white">Display failed to initialize</h1>
            <p className="text-xs text-slate-300 leading-relaxed">
              A rendering error interrupted the arena view on this device. Reloading the page
              usually restores software display mode cleanly.
            </p>
            {this.state.message && (
              <pre className="p-3 rounded bg-[#080B10] border border-slate-800 text-[11px] font-mono text-rose-300 overflow-x-auto whitespace-pre-wrap break-words">
                {this.state.message}
              </pre>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm cursor-pointer transition-colors"
            >
              Reload Arena
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
