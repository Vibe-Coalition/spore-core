"use client";

import { motion } from "framer-motion";
import { Search } from "lucide-react";

interface HeroProps {
  search: string;
  onSearch: (value: string) => void;
  breedCount: number;
}

export default function Hero({ search, onSearch, breedCount }: HeroProps) {
  return (
    <section className="relative pt-32 pb-12 px-6">
      {/* ambient glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-gradient-to-b from-violet-600/20 to-transparent rounded-full blur-[100px] pointer-events-none" />

      <div className="relative max-w-2xl mx-auto text-center">
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-5xl font-bold tracking-tight mb-4"
        >
          Discover Every{" "}
          <span className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
            Cat Breed
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-lg text-white/50 mb-8"
        >
          Explore {breedCount} breeds from around the world. Search, compare,
          and find your perfect companion.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="relative max-w-md mx-auto"
        >
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search breeds, temperament, origin..."
            className="w-full pl-12 pr-4 py-3 glass text-white placeholder-white/30 focus:outline-none focus:border-white/20 transition-colors"
          />
        </motion.div>
      </div>
    </section>
  );
}
