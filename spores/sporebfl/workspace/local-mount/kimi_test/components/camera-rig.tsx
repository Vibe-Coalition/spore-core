"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { getScrollProgressRef } from "@/lib/scroll-provider";

interface CameraKeyframe {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

const heroKeyframes: CameraKeyframe[] = [
  { position: new THREE.Vector3(0, 0, 5), lookAt: new THREE.Vector3(0, 0, 0) },
  { position: new THREE.Vector3(0.5, 0.2, 4), lookAt: new THREE.Vector3(0, 0, 0) },
];

const galleryKeyframes: CameraKeyframe[] = [
  { position: new THREE.Vector3(0, 0, 4), lookAt: new THREE.Vector3(0, 0, -2) },
  { position: new THREE.Vector3(0, 1, 0), lookAt: new THREE.Vector3(0, 0, -5) },
  { position: new THREE.Vector3(0, 0.5, -4), lookAt: new THREE.Vector3(0, 0, -8) },
  { position: new THREE.Vector3(0, 0, -8), lookAt: new THREE.Vector3(0, 0, -12) },
  { position: new THREE.Vector3(0, 0.2, -12), lookAt: new THREE.Vector3(0, -0.5, -16) },
];

const exploreKeyframes: CameraKeyframe[] = [
  { position: new THREE.Vector3(0, 0.2, -12), lookAt: new THREE.Vector3(0, -0.5, -16) },
  { position: new THREE.Vector3(0, 0, -14), lookAt: new THREE.Vector3(0, 0, -20) },
];

function getInterpolatedKeyframe(keyframes: CameraKeyframe[], t: number): CameraKeyframe {
  const clamped = Math.max(0, Math.min(1, t));
  const segments = keyframes.length - 1;
  const rawIndex = clamped * segments;
  const index = Math.floor(rawIndex);
  const frac = rawIndex - index;
  const safeIndex = Math.min(index, segments - 1);
  const nextIndex = safeIndex + 1;

  const a = keyframes[safeIndex];
  const b = keyframes[nextIndex];

  const eased = easeInOutCubic(frac);
  return {
    position: new THREE.Vector3().lerpVectors(a.position, b.position, eased),
    lookAt: new THREE.Vector3().lerpVectors(a.lookAt, b.lookAt, eased),
  };
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export default function CameraRig() {
  const targetPos = useRef(new THREE.Vector3(0, 0, 5));
  const targetLookAt = useRef(new THREE.Vector3(0, 0, 0));
  const velocityAccum = useRef(0);

  useFrame((state, delta) => {
    const ref = getScrollProgressRef();
    // ref.current is ScrollProgress (not a number!)
    const scrollProgress = ref.current;
    const p = scrollProgress.current;
    const vel = scrollProgress.velocity;

    // Add subtle motion based on scroll velocity for deconstructed feel
    velocityAccum.current = THREE.MathUtils.lerp(velocityAccum.current, vel * 0.001, 0.1);
    const shake = Math.sin(state.clock.elapsedTime * 3) * velocityAccum.current;

    let keyframe: CameraKeyframe;

    if (p < 0.25) {
      keyframe = getInterpolatedKeyframe(heroKeyframes, p / 0.25);
    } else if (p < 0.7) {
      keyframe = getInterpolatedKeyframe(galleryKeyframes, (p - 0.25) / 0.45);
    } else {
      keyframe = getInterpolatedKeyframe(exploreKeyframes, (p - 0.7) / 0.3);
    }

    targetPos.current.lerp(keyframe.position, delta * 2);
    targetLookAt.current.lerp(keyframe.lookAt, delta * 2);

    state.camera.position.copy(targetPos.current);
    state.camera.position.x += shake * 0.5;
    state.camera.position.y += shake * 0.3;
    state.camera.lookAt(targetLookAt.current);
  });

  return null;
}
