import { Component, type ReactNode } from "react";
import type { AppStatus } from "./app-state";
import { AppLink } from "./router";

export function AppStatusBoundary({
  status,
  children,
}: {
  status: AppStatus;
  children: ReactNode;
}) {
  if (status.kind === "loading") {
    return <LoadingFrame message={status.message ?? "화면을 준비하고 있어요."} />;
  }

  if (status.kind === "error") {
    return <ErrorFrame message={status.message} />;
  }

  return children;
}

export function LoadingFrame({ message }: { message: string }) {
  return (
    <section className="state-frame" role="status" aria-live="polite">
      <span className="loading-mark" aria-hidden="true" />
      <h1>잠시만 기다려 주세요</h1>
      <p>{message}</p>
    </section>
  );
}

export function ErrorFrame({ message }: { message: string }) {
  return (
    <section className="state-frame" role="alert">
      <span className="state-icon state-icon-error" aria-hidden="true">
        !
      </span>
      <h1>화면을 불러오지 못했어요</h1>
      <p>{message}</p>
      <div className="state-actions">
        <button className="button button-primary" onClick={() => window.location.reload()}>
          다시 불러오기
        </button>
        <AppLink className="button button-secondary" to="/">
          첫 화면으로
        </AppLink>
      </div>
    </section>
  );
}

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFrame message="잠시 후 다시 시도해 주세요." />;
    }

    return this.props.children;
  }
}
