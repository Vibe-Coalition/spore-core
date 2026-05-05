"use client";

import { Cat } from "lucide-react";

export default function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass-strong border-b border-white/[0.06]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 flex items-center justify-center">
            <Cat className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Cat Breeds
          </span>
        </div>
        <div className="text-sm text-white/40">
          Powered by The Cat API
        </div>
      </div>
    </nav>
  );
}
