import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

export function RouteSkeleton({ label = "Loading view..." }: { label?: string }) {
  return (
    <section class="card stack" aria-busy="true" aria-label={label} data-testid="route-skeleton">
      <div class="skeleton skeleton-pill" />
      <div class="skeleton skeleton-title" />
      <div class="skeleton skeleton-line" />
      <div class="skeleton skeleton-line short" />
      <div class="skeleton-grid">
        <div class="skeleton skeleton-box" />
        <div class="skeleton skeleton-box" />
      </div>
    </section>
  );
}

/**
 * Zero-dependency ESM route/component code-splitter with skeleton placeholder.
 */
export function lazyComponent<P extends object>(
  loader: () => Promise<ComponentType<P>>,
  skeletonLabel?: string
): ComponentType<P> {
  let cached: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;

  const load = () => {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = loader().then((Comp) => {
        cached = Comp;
        return Comp;
      });
    }
    return pending;
  };

  return function LazyWrapper(props: P) {
    const [Comp, setComp] = useState<ComponentType<P> | null>(() => cached);

    useEffect(() => {
      let cancelled = false;
      if (!Comp) {
        void load().then((loaded) => {
          if (!cancelled) setComp(() => loaded);
        });
      }
      return () => {
        cancelled = true;
      };
    }, [Comp]);

    if (!Comp) {
      return <RouteSkeleton label={skeletonLabel} />;
    }
    return <Comp {...props} />;
  };
}
