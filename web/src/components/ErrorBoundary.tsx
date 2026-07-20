import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Icon } from "./icons";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Top-level safety net: a crash in any component must never leave the page blank. Shows an error
// card with the message and a reload button.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught a crash:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div id="crash-screen">
          <div className="crash-card">
            <div className="crash-icon"><Icon name="triangle-alert" size={28} /></div>
            <h1>Something went wrong</h1>
            <p className="muted">
              The interface hit a problem and cannot continue in this state.
              Reload the page to try again; if it keeps happening, please report it.
            </p>
            <pre className="crash-message">{this.state.error.message}</pre>
            <button className="mini-btn primary" onClick={() => location.reload()}>
              reload the page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
