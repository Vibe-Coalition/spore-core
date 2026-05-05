import { useRef } from "react";

export interface ScrollProgress {
  current: number;   // 0..1 overall progress
  hero: number;      // 0..1
  gallery: number;   // 0..1
  explore: number;   // 0..1
  velocity: number;  // scroll velocity
}

const defaultProgress: ScrollProgress = {
  current: 0,
  hero: 0,
  gallery: 0,
  explore: 0,
  velocity: 0,
};

export function createScrollProgressRef() {
  return { current: { ...defaultProgress } };
}

export type ScrollProgressRef = ReturnType<typeof createScrollProgressRef>;
