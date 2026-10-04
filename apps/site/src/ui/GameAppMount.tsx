"use client";

import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef } from "react";

/** React must finish the parent cleanup before disposing its separate child root. */
export function scheduleRootUnmount(root: Pick<Root, "unmount"> | undefined) {
  if (root) queueMicrotask(() => root.unmount());
}

/** Mount the existing browser-only game app after hydration. */
export function GameAppMount() {
  const mountPoint = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let root: Root | undefined;

    void import("../../../web/src/app/app")
      .then(({ App }) => {
        if (cancelled || !mountPoint.current) return;
        root = createRoot(mountPoint.current);
        root.render(<App transportAdapter="sites-http-sse" />);
      })
      .catch(() => {
        if (cancelled || !mountPoint.current) return;
        mountPoint.current.setAttribute("role", "alert");
        mountPoint.current.textContent = "게임 화면을 불러오지 못했어요. 새로고침해 주세요.";
      });

    return () => {
      cancelled = true;
      scheduleRootUnmount(root);
    };
  }, []);

  return (
    <div ref={mountPoint}>
      <p className="site-app-loading" role="status" aria-live="polite">
        게임 화면을 준비하고 있어요.
      </p>
    </div>
  );
}
