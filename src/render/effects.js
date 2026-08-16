// Short-lived visuals: tracers, muzzle flash, impact sparks and bullet holes.
// Everything is pooled — no allocation during a firefight.

import * as THREE from '../../vendor/three.module.js?v=bc0527d3';

const TRACER_POOL = 24;
const DECAL_POOL = 96;
// Impact sparks are lights, and a light that exists costs every pixel a little
// whether it is lit or not — they stay in the scene so their shaders are never
// rebuilt mid-round, so the pool is only as big as it has to be. A spark lives
// 90 ms; at eight hundred rounds a minute three are alive at once.
const SPARK_POOL = 6;

// Physical light units, same as the room lights.
const MUZZLE_CANDELA = 120;
const SPARK_CANDELA = 16;

export function createEffects(scene) {
  // ── Tracers ──
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i++) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 5), tracerMat.clone());
    m.visible = false;
    scene.add(m);
    tracers.push({ mesh: m, life: 0 });
  }

  // ── Bullet holes ──
  const decalMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0c, transparent: true, opacity: 0.9 });
  const decals = [];
  for (let i = 0; i < DECAL_POOL; i++) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.035, 8), decalMat.clone());
    m.visible = false;
    scene.add(m);
    decals.push(m);
  }
  let decalIndex = 0;

  // ── Impact sparks ──
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i++) {
    // Alive from the first frame at zero intensity. A light appearing later
    // changes the set of lights every material is compiled against, and Three
    // rebuilds all of those shaders the moment it happens — which is a freeze
    // of seconds, exactly when the first shot is fired.
    const light = new THREE.PointLight(0xffb060, 0, 2.2, 2);
    scene.add(light);
    sparks.push({ light, life: 0 });
  }

  // ── Muzzle flash (attached to the camera rig by the caller) ──
  const muzzle = new THREE.PointLight(0xffcf8a, 0, 7, 2);
  scene.add(muzzle);
  let muzzleLife = 0;

  function spawnTracer(from, to) {
    const slot = tracers.find((t) => t.life <= 0) ?? tracers[0];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;
    slot.mesh.scale.set(1, len, 1);
    slot.mesh.position.set(from.x + dx / 2, from.y + dy / 2, from.z + dz / 2);
    slot.mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx / len, dy / len, dz / len),
    );
    slot.mesh.visible = true;
    slot.mesh.material.opacity = 0.8;
    slot.life = 0.055;
  }

  // `attachTo` is the thing that was hit, when that thing can move — a door.
  // A hole punched in a door belongs to the door: parented to its pivot it
  // swings with the panel, and it goes with the panel when the glass is
  // shattered out of the frame. Left in the world it would hang in mid-air in
  // the doorway, which is exactly what it used to do.
  function spawnImpact(pos, normal, material, attachTo = null) {
    if (material !== 'flesh') {
      const d = decals[decalIndex++ % DECAL_POOL];
      // Free it from whatever it was stuck to last time round the pool.
      if (d.parent !== scene) scene.attach(d);
      d.position.set(
        pos.x + normal.x * 0.006,
        pos.y + normal.y * 0.006,
        pos.z + normal.z * 0.006,
      );
      d.lookAt(
        pos.x + normal.x,
        pos.y + normal.y,
        pos.z + normal.z,
      );
      // `attach` keeps it exactly where it is and hands it to the new parent.
      if (attachTo) attachTo.attach(d);
      d.visible = true;
    }
    const s = sparks.find((x) => x.life <= 0) ?? sparks[0];
    s.light.position.set(pos.x + normal.x * 0.1, pos.y + normal.y * 0.1, pos.z + normal.z * 0.1);
    s.light.color.setHex(material === 'flesh' ? 0xff3020 : 0xffb060);
    s.life = 0.09;
  }

  function flash(pos) {
    muzzle.position.set(pos.x, pos.y, pos.z);
    muzzleLife = 0.045;
  }

  function update(dt) {
    for (const t of tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, (t.life / 0.055) * 0.8);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const s of sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.light.intensity = Math.max(0, (s.life / 0.09) * SPARK_CANDELA);
    }
    if (muzzleLife > 0) {
      muzzleLife -= dt;
      muzzle.intensity = Math.max(0, (muzzleLife / 0.045) * MUZZLE_CANDELA);
    }
  }

  function clearDecals() {
    for (const d of decals) {
      if (d.parent !== scene) scene.attach(d);
      d.visible = false;
    }
  }

  // Show every pooled object for one frame so its geometry and shaders reach
  // the GPU while the loading screen is still up. Returns the undo.
  function prime() {
    for (const t of tracers) t.mesh.visible = true;
    for (const d of decals) d.visible = true;
    return () => {
      for (const t of tracers) if (t.life <= 0) t.mesh.visible = false;
      for (const d of decals) d.visible = false;
    };
  }

  return { spawnTracer, spawnImpact, flash, update, clearDecals, prime };
}
