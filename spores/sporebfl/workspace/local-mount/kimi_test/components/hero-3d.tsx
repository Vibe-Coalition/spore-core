"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import * as THREE from "three";

function EmissiveKnot() {
  const meshRef = useRef<THREE.Mesh>(null);

  const ringColor = useMemo(() => new THREE.Color("#c4b5fd"), []);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    meshRef.current.rotation.x = t * 0.15;
    meshRef.current.rotation.y = t * 0.2;
    meshRef.current.rotation.z = t * 0.08;

    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 1.5 + Math.sin(t * 1.2) * 0.5;
  });

  return (
    <Float
      speed={1.5}
      rotationIntensity={0.3}
      floatIntensity={0.5}
      floatingRange={[-0.3, 0.3]}
    >
      <mesh ref={meshRef}>
        <torusKnotGeometry args={[1.2, 0.35, 200, 32]} />
        <meshStandardMaterial
          color="#1a0a2e"
          emissive={ringColor}
          emissiveIntensity={1.5}
          roughness={0.2}
          metalness={0.8}
        />
      </mesh>
    </Float>
  );
}

function FloatingParticles() {
  const count = 60;
  const pointsRef = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 8;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10 - 3;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return geo;
  }, []);

  useFrame((state) => {
    if (!pointsRef.current) return;
    const t = state.clock.elapsedTime;
    const posArray = pointsRef.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < count; i++) {
      posArray[i * 3 + 1] += Math.sin(t * 0.5 + i) * 0.001;
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        color="#5eead4"
        size={0.04}
        transparent
        opacity={0.6}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

function OrbitingSatellite({ index }: { index: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const radius = 2.5 + index * 0.8;
  const speed = 0.3 + index * 0.15;
  const offset = (index * Math.PI * 2) / 3;
  const color = index % 2 === 0 ? "#5eead4" : "#c4b5fd";
  const scale = 0.08 - index * 0.015;

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime * speed + offset;
    ref.current.position.x = Math.cos(t) * radius;
    ref.current.position.z = Math.sin(t) * radius;
    ref.current.position.y = Math.sin(t * 2) * 0.5;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[scale, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={2}
        roughness={0.1}
        metalness={0.9}
      />
    </mesh>
  );
}

export default function Hero3D() {
  return (
    <group>
      <EmissiveKnot />
      <FloatingParticles />
      {[0, 1, 2].map((i) => (
        <OrbitingSatellite key={i} index={i} />
      ))}
    </group>
  );
}
