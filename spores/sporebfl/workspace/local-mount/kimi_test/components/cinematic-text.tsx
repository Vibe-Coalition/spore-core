"use client";

import { useRef, useEffect } from "react";
import { motion, useInView, useAnimation } from "framer-motion";

interface CinematicTextProps {
  text: string;
  subtext?: string;
  className?: string;
  variant?: "hero" | "section" | "subtle";
}

export default function CinematicText({
  text,
  subtext,
  className = "",
  variant = "section",
}: CinematicTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: false, amount: 0.3 });
  const controls = useAnimation();

  useEffect(() => {
    if (isInView) {
      controls.start("visible");
    } else {
      controls.start("hidden");
    }
  }, [isInView, controls]);

  const sizeClasses = {
    hero: "text-[12vw]",
    section: "text-[8vw]",
    subtle: "text-[4vw]",
  };

  return (
    <div
      ref={ref}
      className={`pointer-events-none select-none ${className}`}
    >
      <div className="overflow-hidden" style={{ perspective: "1000px" }}>
        <h1
          className={`${sizeClasses[variant]} font-black tracking-tighter leading-[0.85] text-white mix-blend-screen`}
        >
          {text.split(" ").map((word, wordIdx) => (
            <span key={wordIdx} className="inline-block whitespace-nowrap mr-[0.25em]">
              {word.split("").map((letter, letterIdx) => {
                const globalIdx =
                  text.split(" ").slice(0, wordIdx).reduce((acc, w) => acc + w.length, 0) + letterIdx;
                return (
                  <motion.span
                    key={globalIdx}
                    initial={{
                      opacity: 0,
                      y: 100,
                      rotateX: -90,
                      filter: "blur(12px)",
                    }}
                    animate={
                      isInView
                        ? {
                            opacity: 1,
                            y: 0,
                            rotateX: 0,
                            filter: "blur(0px)",
                          }
                        : {
                            opacity: 0,
                            y: 100,
                            rotateX: -90,
                            filter: "blur(12px)",
                          }
                    }
                    transition={{
                      duration: 0.6,
                      delay: globalIdx * 0.04,
                      ease: [0.215, 0.61, 0.355, 1] as [number, number, number, number],
                    }}
                    className="inline-block"
                    style={{ transformOrigin: "center bottom" }}
                  >
                    {letter}
                  </motion.span>
                );
              })}
            </span>
          ))}
        </h1>
      </div>

      {subtext && (
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.8, delay: 0.4, ease: [0.215, 0.61, 0.355, 1] as [number, number, number, number] }}
          className="mt-4 text-lg md:text-xl text-white/50 max-w-md tracking-wide"
        >
          {subtext}
        </motion.p>
      )}
    </div>
  );
}

export function SplitTextReveal({
  children,
  className = "",
  delay = 0,
}: {
  children: string;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });

  const words = children.split(" ");

  return (
    <p ref={ref} className={`overflow-hidden ${className}`}>
      {words.map((word, i) => (
        <motion.span
          key={i}
          initial={{ y: "100%", opacity: 0 }}
          animate={isInView ? { y: "0%", opacity: 1 } : { y: "100%", opacity: 0 }}
          transition={{
            duration: 0.5,
            delay: delay + i * 0.03,
            ease: [0.33, 1, 0.68, 1] as [number, number, number, number],
          }}
          className="inline-block mr-[0.3em]"
        >
          {word}
        </motion.span>
      ))}
    </p>
  );
}
