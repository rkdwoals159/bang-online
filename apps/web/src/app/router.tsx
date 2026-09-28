import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

export type AppRoute =
  | { kind: "home" }
  | { kind: "room-create" }
  | { kind: "room-join" }
  | { kind: "lobby"; roomId: string }
  | { kind: "role-reveal"; roomId: string }
  | { kind: "game"; roomId: string }
  | { kind: "result"; roomId: string }
  | { kind: "not-found"; pathname: string };

function normalizePathname(pathname: string): string {
  const pathOnly = pathname.split(/[?#]/, 1)[0] || "/";
  if (pathOnly === "/") {
    return pathOnly;
  }

  return pathOnly.replace(/\/+$/, "") || "/";
}

export function resolveRoute(pathname: string): AppRoute {
  const path = normalizePathname(pathname);

  if (path === "/") return { kind: "home" };
  if (path === "/rooms/new") return { kind: "room-create" };
  if (path === "/rooms/join") return { kind: "room-join" };

  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "rooms" && segments[1] && segments[1] !== "new" && segments[1] !== "join") {
    const roomId = segments[1];

    if (segments.length === 2) return { kind: "lobby", roomId };
    if (segments.length === 3 && segments[2] === "role") {
      return { kind: "role-reveal", roomId };
    }
    if (segments.length === 3 && segments[2] === "game") {
      return { kind: "game", roomId };
    }
    if (segments.length === 3 && segments[2] === "result") {
      return { kind: "result", roomId };
    }
  }

  return { kind: "not-found", pathname: path };
}

export function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function replaceTo(path: string) {
  if (`${window.location.pathname}${window.location.search}` === path) return;
  window.history.replaceState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function routeLocationKey(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

export function subscribeToRouteChanges(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function AppLink({
  to,
  className,
  ariaLabel,
  children,
}: {
  to: string;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    navigateTo(to);
  }

  return (
    <a className={className} href={to} aria-label={ariaLabel} onClick={handleClick}>
      {children}
    </a>
  );
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(() => routeLocationKey(window.location.pathname, window.location.search));

  useEffect(() => {
    const updateLocation = () => setPathname(routeLocationKey(window.location.pathname, window.location.search));
    return subscribeToRouteChanges(updateLocation);
  }, []);

  return pathname;
}
