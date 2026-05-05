"use client";

import { motion } from "framer-motion";
import { Heart, Scale, ChevronRight } from "lucide-react";
import { Breed } from "@/types/breed";
import { useFavorites } from "@/lib/store";
import { useCompare } from "@/lib/store";
import Image from "next/image";

interface BreedCardProps {
  breed: Breed;
  index: number;
  onOpenDetail: (breed: Breed) => void;
}

export default function BreedCard({ breed, index, onOpenDetail }: BreedCardProps) {
  const { favorites, dispatch: favDispatch } = useFavorites();
  const { compare, dispatch: cmpDispatch } = useCompare();

  const isFav = favorites.includes(breed.id);
  const isCompare = compare.includes(breed.id);

  const temps = breed.temperament.split(",").map((t) => t.trim()).slice(0, 3);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.03 }}
      className="glass glass-hover p-5 cursor-pointer transition-all duration-300 group"
      onClick={() => onOpenDetail(breed)}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">{breed.name}</h3>
          <p className="text-sm text-white/40">{breed.origin}</p>
        </div>
        <div
          className="flex gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => cmpDispatch({ type: "toggle", id: breed.id })}
            className={`p-2 rounded-lg transition-colors ${
              isCompare
                ? "bg-cyan-500/20 text-cyan-400"
                : "hover:bg-white/5 text-white/30 hover:text-white/70"
            }`}
            title="Compare"
          >
            <Scale className="w-4 h-4" />
          </button>
          <button
            onClick={() => favDispatch({ type: "toggle", id: breed.id })}
            className={`p-2 rounded-lg transition-colors ${
              isFav
                ? "bg-violet-500/20 text-violet-400"
                : "hover:bg-white/5 text-white/30 hover:text-white/70"
            }`}
            title="Favorite"
          >
            <Heart className={`w-4 h-4 ${isFav ? "fill-current" : ""}`} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {temps.map((t) => (
          <span
            key={t}
            className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/50"
          >
            {t}
          </span>
        ))}
      </div>

      <p className="text-sm text-white/50 line-clamp-2 mb-4 leading-relaxed">
        {breed.description}
      </p>

      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">
          Lifespan: {breed.life_span} years
        </span>
        <span className="text-sm text-white/40 group-hover:text-cyan-400 transition-colors flex items-center gap-1">
          Details <ChevronRight className="w-4 h-4" />
        </span>
      </div>
    </motion.div>
  );
}

export function BreedSkeleton({ index }: { index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.03 }}
      className="glass p-5 h-[240px]"
    >
      <div className="flex gap-3 mb-4">
        <div className="w-24 h-5 rounded shimmer" />
        <div className="w-16 h-5 rounded shimmer ml-auto" />
      </div>
      <div className="w-full h-4 rounded shimmer mb-2" />
      <div className="w-3/4 h-4 rounded shimmer mb-6" />
      <div className="flex gap-1.5 mb-4">
        <div className="w-16 h-5 rounded-full shimmer" />
        <div className="w-14 h-5 rounded-full shimmer" />
        <div className="w-20 h-5 rounded-full shimmer" />
      </div>
      <div className="w-full h-8 rounded shimmer" />
    </motion.div>
  );
}
