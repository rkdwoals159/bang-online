import type { ReactNode } from "react";
import { AccessibilityStyles } from "../components/accessibility/AccessibilityStyles.js";
import { AppErrorBoundary, AppStatusBoundary } from "./app-frames";
import { AppStateProvider, useAppState } from "./app-state";
import { RoutePage } from "./pages";
import { AppLink, resolveRoute, usePathname } from "./router";

export function App() {
  return (
    <AppStateProvider>
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
      <header className="site-header">
        <AppLink className="brand" to="/" ariaLabel="뱅! 온라인 첫 화면">
          <span className="brand-mark" aria-hidden="true">B!</span>
          <span className="brand-name">BANG! <span>온라인</span></span>
        </AppLink>
        <div className="header-note">
          <span className="header-dot" aria-hidden="true" />
          초대받은 친구들과 함께
        </div>
      </header>
      <div className="main-content">{children}</div>
      <footer className="site-footer">
        <span>기본판 · 4–7명</span>
        <span>게임 규칙은 서버가 판정합니다</span>
      </footer>
    </div>
  );
}
