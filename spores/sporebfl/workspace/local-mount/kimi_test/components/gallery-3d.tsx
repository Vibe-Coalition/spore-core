"use client";

import { useRef, useMemo, useState, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import * as THREE from "three";
import { Breed } from "@/types/breed";
import { getScrollProgressRef } from "@/lib/scroll-provider";

interface Gallery3DProps {
  breeds: Breed[];
  onSelectBreed: (breed: Breed, imageUrl: string) => void;
}

interface BreedImageData {
  breed: Breed;
  imageUrl: string;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: number;
}

function getGalleryPath(index: number, total: number): {
  position: [number, number, number];
  rotation: [number, number, number];
} {
  const t = index / Math.max(total - 1, 1);
  // Winding corridor path - slight S-curve
  const x = Math.sin(t * Math.PI * 1.5) * 1.5;
  const y = Math.sin(t * Math.PI * 2) * 0.8;
  const z = -t * 18 + 2; // starts at z=2, goes to z=-16
  const rotY = Math.cos(t * Math.PI) * 0.3;
  const rotX = (t - 0.5) * 0.2;
  return {
    position: [x, y, z],
    rotation: [rotX, rotY, 0],
  };
}

function SafeImage({ url, scale, opacity }: { url: string; scale: [number, number]; opacity: number }) {
  const textureRef = useRef<THREE.Texture | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        textureRef.current?.dispose();
        textureRef.current = tex;
        setKey((k) => k + 1);
      },
      undefined,
      () => {
        textureRef.current?.dispose();
        textureRef.current = null;
        setKey((k) => k + 1);
      }
    );
    return () => {
      textureRef.current?.dispose();
      textureRef.current = null;
    };
  }, [url]);

  if (!textureRef.current) return null;

  return (
    <mesh key={key}>
      <planeGeometry args={scale} />
      <meshBasicMaterial
        map={textureRef.current}
        transparent
        opacity={opacity}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function BreedPlane({
  data,
  index,
  total,
  progress,
  onSelectBreed,
}: {
  data: BreedImageData;
  index: number;
  total: number;
  progress: number;
  onSelectBreed: (breed: Breed, imageUrl: string) => void;
}) {
  const ref = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  // Calculate reveal progress: each plane reveals as camera scrolls past
  const revealStart = index / Math.max(total, 1);
  const revealEnd = revealStart + 0.15;
  const rawReveal = (progress - revealStart) / (revealEnd - revealStart);
  const reveal = Math.max(0, Math.min(1, rawReveal));

  useFrame((state, delta) => {
    if (!ref.current) return;

    const targetS = data.scale * easeInOutCubic(reveal);
    ref.current.scale.lerp(new THREE.Vector3(targetS, targetS, targetS), delta * 3);

    const floatY = reveal > 0.5 ? Math.sin(state.clock.elapsedTime + index) * 0.05 : 0;
    ref.current.position.y = data.position.y + floatY;
  });

  return (
    <Float speed={1} rotationIntensity={0.1} floatIntensity={0.2}>
      <group
        ref={ref}
        position={data.position}
        rotation={data.rotation}
        scale={0}
        onClick={(e: any) => {
          e.stopPropagation();
          onSelectBreed(data.breed, data.imageUrl);
        }}
        onPointerOver={() => {
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "auto";
        }}
      >
        <SafeImage url={data.imageUrl} scale={[2.4, 1.6]} opacity={reveal} />
        {/* Subtle glow border */}
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.5, 1.7]} />
          <meshBasicMaterial
            color="#c4b5fd"
            transparent
            opacity={reveal * 0.15}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* Hover highlight ring */}
        {hovered && (
          <mesh position={[0, 0, 0.02]}>
            <ringGeometry args={[1.0, 1.15, 32]} />
            <meshBasicMaterial color="#5eead4" transparent opacity={0.6} />
          </mesh>
        )}
      </group>
    </Float>
  );
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export default function Gallery3D({
  breeds,
  onSelectBreed,
}: Gallery3DProps) {
  const groupRef = useRef<THREE.Group>(null);

  const imageData = useMemo(() => {
    const validBreeds = breeds.filter((b) => b.image?.url);
    return validBreeds.map((breed, i) => {
      const path = getGalleryPath(i, validBreeds.length);
      return {
        breed,
        imageUrl: breed.image!.url,
        position: new THREE.Vector3(...path.position),
        rotation: new THREE.Euler(...path.rotation),
        scale: 1,
      } as BreedImageData;
    });
  }, [breeds]);

  useFrame(() => {
    const progress = getScrollProgressRef();
    const galleryP = Math.max(0, Math.min(1, (progress.current.current - 0.25) / 0.45));

    if (groupRef.current) {
      groupRef.current.position.z = galleryP * 2;
    }
  });

  return (
    <group ref={groupRef}>
      {imageData.map((data, i) => (
        <BreedPlane
          key={data.breed.id}
          data={data}
          index={i}
          total={imageData.length}
          progress={getScrollProgressRef().current.current}
          onSelectBreed={onSelectBreed}
        />
      ))}
    </group>
  );
}
