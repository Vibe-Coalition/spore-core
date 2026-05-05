"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Heart, X } from "lucide-react";
import { useFavorites } from "@/lib/store";
import { Breed } from "@/types/breed";

interface FavoritesBarProps {
  breeds: Breed[];
  onOpenDetail: (breed: Breed) => void;
}

export default function FavoritesBar({ breeds, onOpenDetail }: FavoritesBarProps) {
  const { favorites, dispatch } = useFavorites();
  const favBreeds = favorites
    .map((id) => breeds.find((b) => b.id === id))
    .filter(Boolean) as Breed[];

  if (favBreeds.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 100 }}
        animate={{ y: 0 }}
        exit={{ y: 100 }}
        className="fixed bottom-0 left-0 right-0 z-40 glass-strong border-t border-white/[0.06]"
      >
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-white/50 flex-shrink-0">
            <Heart className="w-4 h-4 text-violet-400 fill-current" />
            <span>{favBreeds.length} favorite{favBreeds.length > 1 ? "s" : ""}</span>
          </div>

          <div className="flex gap-2 overflow-x-auto scrollbar-hide flex-1">
            {favBreeds.map((breed) => (
              <button
                key={breed.id}
                onClick={() => onOpenDetail(breed)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg glass text-sm hover:bg-white/10 transition-colors whitespace-nowrap"
              >
                <span>{breed.name}</span>
                <X
                  className="w-3 h-3 text-white/30 hover:text-white/70"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: "remove", id: breed.id });
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
