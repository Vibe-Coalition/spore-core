"use client";

import { useRef, useEffect, useState } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Breed } from "@/types/breed";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

interface BreedSpotlightProps {
  breed: Breed | null;
  imageUrl: string | null;
  onClose: () => void;
}

export default function BreedSpotlight({ breed, imageUrl, onClose }: BreedSpotlightProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (breed && imageUrl) {
      setVisible(true);
      ScrollTrigger.getAll().forEach((st) => st.disable());
      if (wrapperRef.current) {
        gsap.fromTo(
          wrapperRef.current,
          { opacity: 0, y: 40 },
          { opacity: 1, y: 0, duration: 0.8, ease: "power3.out", delay: 0.4 }
        );
      }
    } else {
      setVisible(false);
      ScrollTrigger.getAll().forEach((st) => st.enable());
    }

    return () => {
      ScrollTrigger.getAll().forEach((st) => st.enable());
    };
  }, [breed, imageUrl]);

  if (!breed || !visible) return null;

  return (
    <Html
      transform={false}
      position={[0, 0, 0]}
      fullscreen
      zIndexRange={[100, 200]}
    >
      <div
        ref={wrapperRef}
        className="fixed inset-0 z-[100] flex items-end justify-center pb-16 pointer-events-auto"
        style={{ opacity: 0 }}
      >
        {/* Background overlay */}
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-xl"
          onClick={onClose}
        />

        {/* Content card */}
        <div className="relative z-10 w-full max-w-2xl mx-4">
          <div className="glass p-8 md:p-10">
            {/* Close button */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors text-white"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M1 1L15 15M1 15L15 1" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>

            {/* Breed name */}
            <h2 className="text-5xl md:text-7xl font-black tracking-tighter text-white mb-2 leading-none">
              {breed.name.split(" ")[0]}
              <span className="text-[#c4b5fd]">
                {breed.name.split(" ").slice(1).join(" ")}
              </span>
            </h2>

            {/* Origin badge */}
            <div className="flex items-center gap-3 mb-6">
              <span className="px-3 py-1 text-xs font-semibold tracking-widest uppercase bg-[#c4b5fd]/20 text-[#c4b5fd] rounded-full">
                {breed.origin}
              </span>
              <span className="text-sm text-white/50">
                {breed.life_span} years
              </span>
            </div>

            {/* Description */}
            <p className="text-lg md:text-xl text-white/80 leading-relaxed mb-8 max-w-prose">
              {breed.description}
            </p>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Affection" value={breed.affection_level} max={5} />
              <Stat label="Energy" value={breed.energy_level} max={5} />
              <Stat label="Intelligence" value={breed.intelligence} max={5} />
            </div>

            {/* Temperament */}
            <div className="mt-6 flex flex-wrap gap-2">
              {breed.temperament.split(", ").map((t) => (
                <span
                  key={t}
                  className="px-3 py-1 text-xs text-white/60 border border-white/10 rounded-full"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Html>
  );
}

function Stat({ label, value, max }: { label: string; value?: number; max: number }) {
  const v = value ?? 0;
  return (
    <div className="space-y-2">
      <span className="text-xs text-white/40 uppercase tracking-widest">{label}</span>
      <div className="flex gap-1">
        {Array.from({ length: max }).map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full ${
              i < v ? "bg-[#5eead4]" : "bg-white/10"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
