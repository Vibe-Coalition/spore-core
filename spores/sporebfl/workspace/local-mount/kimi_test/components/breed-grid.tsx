"use client";

import { Breed } from "@/types/breed";
import BreedCard, { BreedSkeleton } from "./breed-card";

interface BreedGridProps {
  breeds: Breed[];
  isLoading: boolean;
  onOpenDetail: (breed: Breed) => void;
}

export default function BreedGrid({ breeds, isLoading, onOpenDetail }: BreedGridProps) {
  if (isLoading) {
    return (
      <section className="max-w-7xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 12 }).map((_, i) => (
            <BreedSkeleton key={i} index={i} />
          ))}
        </div>
      </section>
    );
  }

  if (breeds.length === 0) {
    return (
      <section className="max-w-7xl mx-auto px-6 pb-24 text-center py-20">
        <p className="text-xl text-white/30">No breeds found matching your search.</p>
      </section>
    );
  }

  return (
    <section className="max-w-7xl mx-auto px-6 pb-24">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {breeds.map((breed, i) => (
          <BreedCard
            key={breed.id}
            breed={breed}
            index={i}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </div>
    </section>
  );
}
