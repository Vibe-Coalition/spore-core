# Cat Breeds — Cinematic 3D Explorer

A cinematic, scroll-driven 3D experience for exploring cat breeds. Built as a Next.js 15 app with React Three Fiber, GSAP ScrollTrigger, and a glassmorphism dark UI.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![React](https://img.shields.io/badge/React-19-61DAFB) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6) ![Three.js](https://img.shields.io/badge/Three.js-R3F-black)

## Live Demo

```bash
npm run dev
# open http://localhost:3000
```

## Features

- **Cinematic Scroll Gallery** — 600vh scroll section with a camera flying through a 3D corridor of breed image planes
- **Hero Scene** — Animated torus knot, floating particles, and orbiting satellites with post-processing bloom
- **Breed Explorer** — Searchable grid with breed cards, detail modals, favorites, and side-by-side comparison
- **Glassmorphism UI** — Dark theme with translucent panels, subtle borders, and ambient glow
- **Smooth Scroll** — Lenis + GSAP ScrollTrigger with zero React re-renders on scroll
- **Image Resilience** — Safe texture loading that silently handles dead Cat API image URLs without crashing the Canvas

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router), React 19, TypeScript (strict) |
| Styling | Tailwind CSS v4, custom CSS glassmorphism tokens |
| 3D | React Three Fiber 9, Drei, Postprocessing (Bloom, Vignette, Noise) |
| Animation | GSAP ScrollTrigger, Lenis smooth scroll, Framer Motion |
| State | React Context + useReducer, localStorage persistence |
| Data | [The Cat API](https://thecatapi.com/) v1 |

## Project Structure

```
app/
  page.tsx           # Main page with Hero, Gallery, Explore sections
  layout.tsx         # Root layout with Inter font
  globals.css        # Tailwind v4 + glassmorphism tokens + grain overlay
components/
  scene.tsx          # Fixed R3F Canvas with post-processing
  camera-rig.tsx     # Scroll-driven camera lerping
  hero-3d.tsx        # Torus knot, particles, satellites
  gallery-3d.tsx     # Breed image corridor with reveal animation
  breed-grid.tsx     # Searchable breed cards + favorites/comparison
  cinematic-text.tsx # 3D letter-flip text reveals
lib/
  scroll-provider.tsx   # Lenis + GSAP init, shared scroll progress ref
  cat-api.ts            # The Cat API client with image validation
  scroll-progress.ts    # Hook to read scroll state in R3F
hooks/
  use-scroll-progress.ts
  use-cat-data.ts
types/
  breed.ts
```

## Architecture

### Scroll Sync Pattern

Lenis writes scroll progress to a **shared mutable ref** (`getScrollProgressRef()`). R3F components read this ref inside `useFrame` loops. This avoids React re-renders entirely during scroll — the 3D scene updates at 60fps independently of the React tree.

```
DOM layer (pointer-events: auto)  →  scroll events
       ↓
scroll-provider writes to mutable ref
       ↓
R3F layer (pointer-events: none)  →  useFrame reads ref, updates camera
```

### 3D Scene

A full-screen fixed `<Canvas>` sits behind all DOM content (`pointer-events: none`). Three.js handles the background visuals; HTML handles the UI overlays. Post-processing adds bloom, vignette, and film grain.

### Image Safety

The `SafeImage` component loads textures via `THREE.TextureLoader` directly (not Drei's `<Image>`) with try/catch error handling. If a Cat API image URL 404s, the plane renders empty with an emissive border glow — the Canvas never crashes.

## Setup

```bash
# Install dependencies
npm install

# Add your Cat API key
echo "NEXT_PUBLIC_CAT_API_KEY=your_key_here" > .env.local

# Start dev server
npm run dev
```

## Build

```bash
npm run build
```

Outputs a static export. First load: ~154 kB. Route bundle: ~449 kB. Zero TypeScript errors.

## Credits

- Breed data & images: [The Cat API](https://thecatapi.com/)
- 3D environment preset: `@react-three/drei` Night HDRI

## License

MIT
