"use client";

import { Canvas } from "@react-three/fiber";
import { Environment, PerspectiveCamera } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, Noise } from "@react-three/postprocessing";
import CameraRig from "./camera-rig";

export default function Scene({ children }: { children?: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-0"
      style={{ pointerEvents: "none" }}
    >
      <Canvas
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        }}
        dpr={[1, 2]}
        style={{ background: "#050505" }}
      >
        <PerspectiveCamera makeDefault position={[0, 0, 5]} fov={45} near={0.1} far={100} />
        <color attach="background" args={["#050505"]} />
        <fog attach="fog" args={["#050505", 8, 35]} />
        
        <ambientLight intensity={0.15} />
        <directionalLight position={[5, 5, 5]} intensity={0.5} color="#c4b5fd" />
        <directionalLight position={[-3, -2, -5]} intensity={0.3} color="#5eead4" />
        <pointLight position={[0, 0, 2]} intensity={1} color="#c4b5fd" distance={10} />
        
        <Environment preset="night" />
        
        <CameraRig />
        
        {children}
        
        <EffectComposer>
          <Bloom luminanceThreshold={0.2} luminanceSmoothing={0.9} intensity={1.2} />
          <Vignette eskil={false} offset={0.1} darkness={0.7} />
          <Noise opacity={0.04} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
