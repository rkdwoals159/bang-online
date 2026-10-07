import type { ReactNode } from "react";
import { NicknameSettings } from "../features/profile/NicknameSettings.js";
import { AccessibilityStyles } from "../components/accessibility/AccessibilityStyles.js";
import { AppErrorBoundary, AppStatusBoundary } from "./app-frames";
import { AppStateProvider, useAppState } from "./app-state";
import { RoutePage } from "./pages";
import { AppLink, resolveRoute, usePathname } from "./router";

export function App({ transportAdapter }: { transportAdapter?: "sites-http-sse" | "socket-io" } = {}) {
  return (
    <AppStateProvider adapter={transportAdapter}>
      <AccessibilityStyles />
      <AppShell>
        <AppErrorBoundary>
          <GlobalAppBoundary>
            <CurrentRoute />
          </GlobalAppBoundary>
        </AppErrorBoundary>
      </AppShell>
    </AppStateProvider>
  );
}

function GlobalAppBoundary({ children }: { children: ReactNode }) {
  const { status } = useAppState();
  return <AppStatusBoundary status={status}>{children}</AppStatusBoundary>;
}

function CurrentRoute() {
  const locationKey = usePathname();
  const route = resolveRoute(locationKey);
  return <RoutePage key={locationKey} route={route} />;
}

function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      <header className="site-header">
        <AppLink className="brand" to="/" ariaLabel="뱅! 온라인 첫 화면">
          <span className="brand-mark" aria-hidden="true">B!</span>
          <span className="brand-name">BANG! <span>온라인</span></span>
        </AppLink>
        <NicknameSettings />
      </header>
      <main className="main-content" id="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
