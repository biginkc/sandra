import { startNavigationTiming } from "./lib/performance/browser-timing";

export function onRouterTransitionStart(url: string) {
  startNavigationTiming(url);
}
