"use client";

import { useEffect, useRef, ReactNode } from "react";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollProgress, ScrollProgressRef } from "@/hooks/use-scroll-progress";

gsap.registerPlugin(ScrollTrigger);

let sharedRef: ScrollProgressRef = { current: { current: 0, hero: 0, gallery: 0, explore: 0, velocity: 0 } };

export function getScrollProgressRef() {
  return sharedRef;
}

export default function ScrollProvider({ children }: { children: ReactNode }) {
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    const lenis = new Lenis({
      lerp: 0.08,
      smoothWheel: true,
    });
    lenisRef.current = lenis;

    lenis.on("scroll", (e: { velocity: number }) => {
      ScrollTrigger.update();
      sharedRef.current.velocity = e.velocity;
    });

    gsap.ticker.add((time) => {
      lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);

    ScrollTrigger.normalizeScroll(true);

    // Per-section scroll triggers writing to shared ref
    const sectionLabels = ["hero", "gallery", "explore"] as const;
    const triggers: ScrollTrigger[] = [];

    for (const label of sectionLabels) {
      const el = document.querySelector(`[data-scroll-section="${label}"]`);
      if (!el) continue;
      const st = ScrollTrigger.create({
        trigger: el,
        start: "top bottom",
        end: "bottom top",
        scrub: true,
        onUpdate: (self) => {
          sharedRef.current[label] = self.progress;
        },
      });
      triggers.push(st);
    }

    const globalSt = ScrollTrigger.create({
      trigger: document.body,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => {
        sharedRef.current.current = self.progress;
      },
    });
    triggers.push(globalSt);

    return () => {
      for (const st of triggers) st.kill();
      lenis.destroy();
      gsap.ticker.remove(lenis.raf);
    };
  }, []);

  return <>{children}</>;
}
