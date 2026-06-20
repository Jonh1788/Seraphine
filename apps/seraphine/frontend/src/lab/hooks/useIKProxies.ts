/**
 * Hook que gerencia proxy meshes (esferas 3D) para IK targets no
 * Animation Lab. Cria/remove esferas no scene conforme ikTargets muda,
 * e conecta o TransformControls (translate) ao target selecionado.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { VrmAvatarController } from '../../avatar/VrmAvatarController';
import type { IKTarget } from '../../avatar/gestures';

export interface UseIKProxiesParams {
  controller: VrmAvatarController | null;
  ikTargets: IKTarget[];
  selectedIkId: string | null;
  ikProxyMeshes: MutableRefObject<Map<string, Mesh>>;
  transformRef: MutableRefObject<TransformControls | null>;
  handleUpdateIKRef: MutableRefObject<(id: string, patch: Partial<IKTarget>) => void>;
}

export function useIKProxies({
  controller, ikTargets, selectedIkId,
  ikProxyMeshes, transformRef, handleUpdateIKRef,
}: UseIKProxiesParams): void {
  const ikSphereGeoRef = useRef<SphereGeometry | null>(null);

  // Sync proxy meshes with ikTargets list.
  useEffect(() => {
    if (!controller) return;
    const scene = controller.getScene();
    const vrm = controller.getVrm();
    if (!scene || !vrm) return;

    const live = ikProxyMeshes.current;
    const wanted = new Set(ikTargets.map(t => t.id));

    // Remove stale
    for (const [id, mesh] of live) {
      if (!wanted.has(id)) {
        scene.remove(mesh);
        (mesh.material as MeshBasicMaterial).dispose();
        live.delete(id);
      }
    }

    // Shared geometry -- created once and disposed on unmount.
    if (!ikSphereGeoRef.current) {
      ikSphereGeoRef.current = new SphereGeometry(0.025, 12, 12);
    }
    const sphereGeo = ikSphereGeoRef.current;
    for (const t of ikTargets) {
      let mesh = live.get(t.id);
      if (!mesh) {
        const mat = new MeshBasicMaterial({
          color: t.chain === 'head' ? 0xf59e0b
               : t.chain === 'leftArm' ? 0x60a5fa
               : 0xef4444,
          transparent: true,
          opacity: 0.85,
          depthTest: false,
        });
        mesh = new Mesh(sphereGeo, mat);
        mesh.renderOrder = 1000;
        mesh.userData.ikTargetId = t.id;
        scene.add(mesh);
        live.set(t.id, mesh);
      }
      // Position in world space.
      if (t.space === 'world') {
        mesh.position.set(t.target.x, t.target.y, t.target.z);
      } else {
        mesh.position.set(t.target.x, t.target.y, t.target.z);
        vrm.scene.localToWorld(mesh.position);
      }
    }
  }, [controller, ikTargets, ikProxyMeshes]);

  // Clean up proxy meshes + shared geometry on unmount.
  useEffect(() => {
    return () => {
      if (!controller) return;
      const scene = controller.getScene();
      for (const [, mesh] of ikProxyMeshes.current) {
        scene.remove(mesh);
        (mesh.material as MeshBasicMaterial).dispose();
      }
      ikProxyMeshes.current.clear();
      if (ikSphereGeoRef.current) {
        ikSphereGeoRef.current.dispose();
        ikSphereGeoRef.current = null;
      }
    };
  }, [controller, ikProxyMeshes]);

  // Attach TransformControls to the selected IK target proxy and write
  // drag updates back to state.
  useEffect(() => {
    const tc = transformRef.current;
    if (!tc || !controller) return;
    if (!selectedIkId) return;
    const mesh = ikProxyMeshes.current.get(selectedIkId);
    if (!mesh) return;
    tc.setMode('translate');
    tc.attach(mesh);
    const vrm = controller.getVrm();
    const onChange = () => {
      const targ = ikTargets.find(t => t.id === selectedIkId);
      if (!targ) return;
      let nx = mesh.position.x, ny = mesh.position.y, nz = mesh.position.z;
      if (targ.space === 'rig' && vrm) {
        const local = new Vector3(nx, ny, nz);
        vrm.scene.worldToLocal(local);
        nx = local.x; ny = local.y; nz = local.z;
      }
      nx = Math.round(nx * 1000) / 1000;
      ny = Math.round(ny * 1000) / 1000;
      nz = Math.round(nz * 1000) / 1000;
      handleUpdateIKRef.current(selectedIkId, { target: { x: nx, y: ny, z: nz } });
    };
    tc.addEventListener('objectChange', onChange);
    return () => { tc.removeEventListener('objectChange', onChange); tc.detach(); };
  }, [selectedIkId, ikTargets, controller, ikProxyMeshes, transformRef, handleUpdateIKRef]);
}
