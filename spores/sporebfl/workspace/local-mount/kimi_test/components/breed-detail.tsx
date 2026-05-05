"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, Heart, Scale, ExternalLink } from "lucide-react";
import { Breed } from "@/types/breed";
import { useFavorites } from "@/lib/store";
import { useCompare } from "@/lib/store";
import ImageGallery from "./image-gallery";

interface BreedDetailProps {
  breed: Breed | null;
  onClose: () => void;
}

export default function BreedDetail({ breed, onClose }: BreedDetailProps) {
  const { favorites, dispatch: favDispatch } = useFavorites();
  const { compare, dispatch: cmpDispatch } = useCompare();

  if (!breed) return null;

  const isFav = favorites.includes(breed.id);
  const isCompare = compare.includes(breed.id);

  const stats = [
    { label: "Affection", value: breed.affection_level },
    { label: "Energy", value: breed.energy_level },
    { label: "Intelligence", value: breed.intelligence },
    { label: "Child Friendly", value: breed.child_friendly },
    { label: "Dog Friendly", value: breed.dog_friendly },
    { label: "Grooming", value: breed.grooming },
  ];

  return (
    <AnimatePresence>
      {breed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          onClick={onClose}
        >
          {/* backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto glass-strong scrollbar-hide"
          >
            {/* header */}
            <div className="sticky top-0 z-10 flex items-center justify-between p-6 border-b border-white/[0.06] bg-slate-900/80 backdrop-blur-xl">
              <div>
                <h2 className="text-2xl font-bold">{breed.name}</h2>
                <p className="text-sm text-white/40">{breed.origin}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => cmpDispatch({ type: "toggle", id: breed.id })}
                  className={`p-2.5 rounded-xl transition-colors ${
                    isCompare
                      ? "bg-cyan-500/20 text-cyan-400"
                      : "glass hover:text-cyan-400 text-white/40"
                  }`}
                  title="Compare"
                >
                  <Scale className="w-5 h-5" />
                </button>
                <button
                  onClick={() => favDispatch({ type: "toggle", id: breed.id })}
                  className={`p-2.5 rounded-xl transition-colors ${
                    isFav
                      ? "bg-violet-500/20 text-violet-400"
                      : "glass hover:text-violet-400 text-white/40"
                  }`}
                  title="Favorite"
                >
                  <Heart className={`w-5 h-5 ${isFav ? "fill-current" : ""}`} />
                </button>
                <button
                  onClick={onClose}
                  className="p-2.5 rounded-xl glass hover:text-white text-white/40 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {/* images */}
              <ImageGallery breedId={breed.id} />

              {/* description */}
              <p className="text-white/70 leading-relaxed">{breed.description}</p>

              {/* temperament */}
              <div>
                <h4 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">
                  Temperament
                </h4>
                <div className="flex flex-wrap gap-2">
                  {breed.temperament.split(",").map((t) => (
                    <span
                      key={t.trim()}
                      className="px-3 py-1 rounded-full glass text-sm text-white/60"
                    >
                      {t.trim()}
                    </span>
                  ))}
                </div>
              </div>

              {/* stats */}
              <div>
                <h4 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">
                  Stats
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {stats.map((stat) => (
                    <div key={stat.label} className="glass p-4">
                      <div className="text-xs text-white/40 mb-1">{stat.label}</div>
                      <div className="flex gap-0.5">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <div
                            key={i}
                            className={`h-1.5 flex-1 rounded-full ${
                              i < stat.value
                                ? "bg-gradient-to-r from-violet-500 to-cyan-400"
                                : "bg-white/10"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* meta */}
              <div className="flex flex-wrap gap-4 text-sm text-white/40">
                <span>Lifespan: {breed.life_span} years</span>
                {breed.weight && (
                  <span>Weight: {breed.weight.metric} kg</span>
                )}
                {breed.wikipedia_url && (
                  <a
                    href={breed.wikipedia_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors"
                  >
                    Wikipedia <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
