"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchBreeds, getValidatedBreedImage } from "@/lib/cat-api";
import { Breed } from "@/types/breed";
import ScrollProvider from "@/lib/scroll-provider";
import Scene from "@/components/scene";
import Hero3D from "@/components/hero-3d";
import Gallery3D from "@/components/gallery-3d";
import BreedSpotlight from "@/components/breed-spotlight";
import CinematicText, { SplitTextReveal } from "@/components/cinematic-text";
import { motion, AnimatePresence } from "framer-motion";

const FEATURED_BREED_IDS = [
  "beng", "munch", "siam", "ragd", "mcoo", "sphy",
  "sfol", "pers", "abys", "norw", "bomb", "birm",
];

export default function Home() {
  const [breeds, setBreeds] = useState<Breed[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBreed, setSelectedBreed] = useState<Breed | null>(null);
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const allBreeds: Breed[] = await fetchBreeds();
        const featured = allBreeds.filter((b) => FEATURED_BREED_IDS.includes(b.id));

        // Validate image URLs - some CDN links go dead. Fall back to fresh fetches.
        const withImages = await Promise.all(
          featured.map(async (breed) => {
            try {
              const valid = await getValidatedBreedImage(breed.id);
              return valid ? { ...breed, image: { url: valid.url } } : null;
            } catch {
              return null;
            }
          })
        );

        setBreeds(withImages.filter(Boolean));
      } catch {
        setBreeds([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSelectBreed = useCallback((breed: Breed, imageUrl: string) => {
    setSelectedBreed(breed);
    setSelectedImageUrl(imageUrl);
  }, []);

  const handleCloseSpotlight = useCallback(() => {
    setSelectedBreed(null);
    setSelectedImageUrl(null);
  }, []);

  return (
    <ScrollProvider>
      <Scene>
        <Hero3D />
        <Gallery3D breeds={breeds} onSelectBreed={handleSelectBreed} />
      </Scene>

      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="fixed inset-0 z-[200] bg-[#050505] flex flex-col items-center justify-center"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className="w-12 h-12 border-2 border-transparent border-t-[#c4b5fd] border-r-[#5eead4] rounded-full"
            />
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="mt-6 text-sm text-white/40 tracking-[0.3em] uppercase"
            >
              Loading Felines
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative z-10">
        <section data-scroll-section="hero" className="relative" style={{ height: "300vh" }}>
          <div className="sticky top-0 h-screen flex flex-col items-center justify-center">
            <div className="text-center px-6">
              <CinematicText
                text="FELINE"
                subtext="Twelve extraordinary breeds. One infinite scroll."
                variant="hero"
              />
              <div className="mt-12 flex items-center justify-center gap-2">
                <motion.div
                  animate={{ y: [0, 8, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                  className="flex flex-col items-center gap-1"
                >
                  <span className="text-xs text-white/30 tracking-[0.3em] uppercase">
                    Scroll to explore
                  </span>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-white/30">
                    <path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </motion.div>
              </div>
            </div>
          </div>
        </section>

        <section data-scroll-section="gallery" className="relative" style={{ height: "600vh" }}>
          <div className="sticky top-0 h-screen flex items-start justify-center pt-24 pointer-events-none">
            <CinematicText text="GALLERY" variant="section" className="opacity-30" />
          </div>

          <div className="absolute top-[25%] left-8 max-w-xs pointer-events-none">
            <SplitTextReveal delay={0} className="text-xl md:text-2xl font-light text-white/60 leading-relaxed">
              Each breed carries a universe of instinct, grace, and wild heritage.
            </SplitTextReveal>
          </div>

          <div className="absolute top-[55%] right-8 max-w-xs text-right pointer-events-none">
            <SplitTextReveal delay={0} className="text-xl md:text-2xl font-light text-white/60 leading-relaxed">
              Scroll deeper. The camera follows your curiosity.
            </SplitTextReveal>
          </div>

          <div className="absolute top-[80%] left-1/2 -translate-x-1/2 text-center pointer-events-none">
            <SplitTextReveal delay={0} className="text-lg md:text-xl font-light text-white/40 tracking-widest uppercase">
              Click any image to reveal its story
            </SplitTextReveal>
          </div>
        </section>

        <section data-scroll-section="explore" className="relative" style={{ height: "200vh" }}>
          <div className="sticky top-0 h-screen flex flex-col items-center justify-center">
            <CinematicText
              text="EXPLORE"
              subtext="The cat API holds hundreds more breeds. The journey never ends."
              variant="section"
            />

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.6, duration: 0.8 }}
              className="mt-12 flex gap-4"
            >
              <a
                href="https://thecatapi.com"
                target="_blank"
                rel="noopener noreferrer"
                className="glass px-8 py-3 text-sm font-medium tracking-widest uppercase text-white hover:bg-white/10 transition-colors"
              >
                The Cat API
              </a>
              <button
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                className="glass px-8 py-3 text-sm font-medium tracking-widest uppercase text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              >
                Back to Top
              </button>
            </motion.div>
          </div>
        </section>
      </main>

      <BreedSpotlight
        breed={selectedBreed}
        imageUrl={selectedImageUrl}
        onClose={handleCloseSpotlight}
      />
    </ScrollProvider>
  );
}
