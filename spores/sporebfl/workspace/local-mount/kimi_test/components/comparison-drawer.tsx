"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, Scale } from "lucide-react";
import { useCompare } from "@/lib/store";
import { Breed } from "@/types/breed";
import Image from "next/image";

interface ComparisonDrawerProps {
  breeds: Breed[];
  onOpenDetail: (breed: Breed) => void;
}

const STATS = [
  { key: "affection_level", label: "Affection" },
  { key: "energy_level", label: "Energy" },
  { key: "intelligence", label: "Intelligence" },
  { key: "child_friendly", label: "Child Friendly" },
  { key: "dog_friendly", label: "Dog Friendly" },
  { key: "grooming", label: "Grooming" },
  { key: "health_issues", label: "Health Issues" },
  { key: "social_needs", label: "Social Needs" },
  { key: "stranger_friendly", label: "Stranger Friendly" },
  { key: "vocalisation", label: "Vocalisation" },
];

export default function ComparisonDrawer({ breeds, onOpenDetail }: ComparisonDrawerProps) {
  const { compare, dispatch } = useCompare();
  const cmpBreeds = compare
    .map((id) => breeds.find((b) => b.id === id))
    .filter(Boolean) as Breed[];

  const isOpen = cmpBreeds.length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 30, stiffness: 300 }}
          className="fixed top-0 right-0 bottom-0 z-[55] w-full max-w-lg glass-strong border-l border-white/[0.06] overflow-y-auto scrollbar-hide"
        >
          {/* header */}
          <div className="sticky top-0 z-10 flex items-center justify-between p-6 border-b border-white/[0.06] bg-slate-900/80 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <Scale className="w-5 h-5 text-cyan-400" />
              <h2 className="text-lg font-semibold">Compare Breeds</h2>
            </div>
            <button
              onClick={() => dispatch({ type: "clear" })}
              className="p-2 rounded-lg glass hover:text-white text-white/40 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6 space-y-6">
            {/* breed headers */}
            <div className="grid grid-cols-2 gap-4">
              {cmpBreeds.map((breed) => (
                <button
                  key={breed.id}
                  onClick={() => onOpenDetail(breed)}
                  className="text-left glass p-4 hover:bg-white/10 transition-colors"
                >
                  <h3 className="font-semibold mb-1">{breed.name}</h3>
                  <p className="text-xs text-white/40">{breed.origin}</p>
                  <p className="text-xs text-white/30 mt-1">
                    {breed.life_span} years
                  </p>
                </button>
              ))}
            </div>

            {/* stat bars */}
            <div className="space-y-4">
              {STATS.map((stat) => (
                <div key={stat.key}>
                  <div className="text-xs text-white/40 mb-2">{stat.label}</div>
                  <div className="grid grid-cols-2 gap-4">
                    {cmpBreeds.map((breed) => {
                      const val = (breed as any)[stat.key] as number;
                      return (
                        <div key={breed.id} className="flex gap-1">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <div
                              key={i}
                              className={`h-2 flex-1 rounded-full ${
                                i < val
                                  ? "bg-gradient-to-r from-violet-500 to-cyan-400"
                                  : "bg-white/10"
                              }`}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* temperament overlap */}
            {cmpBreeds.length === 2 && (
              <div>
                <h4 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">
                  Temperament
                </h4>
                <div className="flex flex-wrap gap-2">
                  {cmpBreeds[0].temperament
                    .split(",")
                    .map((t) => t.trim())
                    .map((t) => {
                      const otherHas = cmpBreeds[1].temperament
                        .toLowerCase()
                        .includes(t.toLowerCase());
                      return (
                        <span
                          key={t}
                          className={`px-3 py-1 rounded-full text-sm ${
                            otherHas
                              ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                              : "glass text-white/50"
                          }`}
                        >
                          {t}
                          {otherHas && " "}
                        </span>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
