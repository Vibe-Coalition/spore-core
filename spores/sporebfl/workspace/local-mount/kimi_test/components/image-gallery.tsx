"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { getValidatedBreedImage } from "@/lib/cat-api";

interface ImageGalleryProps {
  breedId: string;
}

const EXTRA_IMAGES = [
  "https://images.unsplash.com/photo-1573865526739-10659fec78a5",
  "https://images.unsplash.com/photo-1606567595334-d39972c85c9d",
  "https://images.unsplash.com/photo-1533743983669-94fa5c4338ec",
  "https://images.unsplash.com/photo-1586042091284-bd35c8c1d917",
  "https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8",
  "https://images.unsplash.com/photo-1606214174585-fe31582dc6ee",
  "https://images.unsplash.com/photo-1602823668197-af3090e03b4f",
  "https://images.unsplash.com/photo-1574158622682-e40e69881006",
];

export default function ImageGallery({ breedId }: ImageGalleryProps) {
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    // Get the validated main image + extra gallery images
    getValidatedBreedImage(breedId)
      .then((main) => {
        let hash = 0;
        for (let i = 0; i < breedId.length; i++) {
          hash = ((hash << 5) - hash + breedId.charCodeAt(i)) | 0;
        }
        const start = Math.abs(hash) % EXTRA_IMAGES.length;
        const extras = [];
        for (let i = 0; i < 5; i++) {
          extras.push(EXTRA_IMAGES[(start + i) % EXTRA_IMAGES.length]);
        }
        setImages([main?.url || EXTRA_IMAGES[0], ...extras]);
      })
      .catch(() => setImages(EXTRA_IMAGES.slice(0, 4)))
      .finally(() => setLoading(false));
  }, [breedId]);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto scrollbar-hide">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex-shrink-0 w-48 h-32 rounded-xl shimmer" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2">
      {images.map((url, i) => (
        <motion.div
          key={`${url}-${i}`}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.1 }}
          className="flex-shrink-0 relative w-48 h-32 rounded-xl overflow-hidden glass"
        >
          <Image
            src={`${url}?w=400&h=260&fit=crop&q=80`}
            alt="Cat"
            fill
            className="object-cover"
            sizes="200px"
          />
        </motion.div>
      ))}
    </div>
  );
}
