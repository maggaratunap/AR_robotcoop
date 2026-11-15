// Two HUDs driven by the same `ui` description:
//  - DomHud: HTML overlay (Android phones via WebXR DOM overlay, and desktop preview)
//  - Hud3D:  a floating panel drawn to a canvas texture (Quest has no DOM overlay)
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);

export class DomHud {
  constructor() {
    this.key = '';
    this.el = {
      wave: $('stWave'), score: $('stScore'), hp0: $('hp0'), hp1: $('hp1'), bar1: $('bar1'),
      title: $('bnTitle'), body: $('bnBody'), toast: $('bnToast'),
      actions: $('actions'), primary: $('btnPrimary'), secondary: $('btnSecondary'),
      stick: $('stick'), fire: $('btnFire'), emp: $('btnEmp'), top: $('stats'), bars: $('bars'),
    };
  }

  update(ui) {
    const key = JSON.stringify(ui);
    if (key === this.key) return;
    this.key = key;
    const e = this.el, p = ui.play;
    e.title.textContent = ui.title || '';
    e.body.textContent = ui.body || '';
    e.toast.textContent = ui.toast || '';
    e.primary.textContent = ui.primary || '';
    e.primary.hidden = !ui.primary;
    e.secondary.textContent = ui.secondary || '';
    e.secondary.hidden = !ui.secondary;
    e.actions.hidden = !ui.primary && !ui.secondary;
    const playing = !!p && ui.controls;
    e.stick.hidden = e.fire.hidden = e.emp.hidden = !playing;
    e.top.hidden = e.bars.hidden = !p;
    if (p) {
      e.wave.textContent = `WAVE ${p.wave}`;
      e.score.textContent = String(p.score);
      e.hp0.style.width = `${p.hp[0]}%`;
      e.bar1.hidden = p.hp.length < 2;
      if (p.hp.length > 1) e.hp1.style.width = `${p.hp[1]}%`;
      e.emp.textContent = p.emp > 0 ? String(Math.ceil(p.emp)) : 'EMP';
      e.emp.classList.toggle('cool', p.emp > 0);
    }
  }
}

function wrap(g, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word;
      if (g.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

export class Hud3D {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024; this.canvas.height = 512;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.33),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false }),
    );
    this.mesh.renderOrder = 100;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.key = '';
    this.placed = false;
    this._t = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }

  draw(ui) {
    const key = JSON.stringify(ui);
    if (key === this.key) return;
    this.key = key;
    const g = this.g, W = 1024, H = 512, mono = 'ui-monospace, Menlo, Consolas, monospace';
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(11,14,17,0.86)';
    g.beginPath(); g.roundRect(0, 0, W, H, 18); g.fill();
    g.fillStyle = '#ffb020'; g.fillRect(0, 0, 12, H);
    let y = 64;
    const p = ui.play;
    if (p) {
      g.font = `800 52px ${mono}`; g.fillStyle = '#e8eef2'; g.textAlign = 'left';
      g.fillText(`WAVE ${p.wave}`, 44, y);
      g.fillStyle = '#ffb020'; g.textAlign = 'right';
      g.fillText(String(p.score), W - 40, y);
      g.textAlign = 'left';
      y += 30;
      p.hp.forEach((hp, i) => {
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(44, y, W - 88, 30);
        g.fillStyle = i ? '#ff7a3d' : '#29d3ff'; g.fillRect(44, y, (W - 88) * hp / 100, 30);
        g.fillStyle = '#071015'; g.font = `800 22px ${mono}`; g.fillText(`P${i + 1}`, 54, y + 23);
        y += 42;
      });
      g.font = `700 30px ${mono}`;
      g.fillStyle = p.emp > 0 ? '#8b9aa7' : '#ffb020';
      g.fillText(p.emp > 0 ? `EMP ${Math.ceil(p.emp)}s` : 'EMP READY', 44, y + 34);
      y += 70;
    }
    if (ui.title) {
      g.font = `800 40px ${mono}`; g.fillStyle = '#ffb020'; g.textAlign = 'left';
      g.fillText(ui.title.toUpperCase(), 44, y);
      y += 50;
    }
    g.font = '500 31px system-ui, sans-serif'; g.fillStyle = '#e8eef2';
    for (const line of wrap(g, ui.body || '', W - 88)) { if (y > H - 96) break; g.fillText(line, 44, y); y += 40; }
    if (ui.toast) {
      g.font = '700 30px system-ui, sans-serif'; g.fillStyle = '#ff4d5e';
      for (const line of wrap(g, ui.toast, W - 88)) { if (y > H - 60) break; g.fillText(line, 44, y); y += 38; }
    }
    const hints = [];
    if (ui.primary) hints.push(`TRIGGER: ${ui.primary}`);
    if (ui.secondary) hints.push(`GRIP: ${ui.secondary}`);
    if (ui.hint) hints.push(ui.hint);
    if (hints.length) {
      g.font = `700 26px ${mono}`; g.fillStyle = '#4be38a';
      g.fillText(hints.join('   ·   ').toUpperCase(), 44, H - 30);
    }
    this.tex.needsUpdate = true;
  }

  // Lazy tag-along: drifts to a spot in front of and below the viewer's gaze.
  follow(headPos, headQuat, dt, low) {
    this._f.set(0, 0, -1).applyQuaternion(headQuat);
    this._f.y = 0;
    if (this._f.lengthSq() < 1e-4) this._f.set(0, 0, -1);
    this._f.normalize();
    this._t.copy(headPos).addScaledVector(this._f, 0.95);
    this._t.y = headPos.y - (low ? 0.48 : 0.2);
    if (!this.placed) { this.mesh.position.copy(this._t); this.placed = true; }
    else this.mesh.position.lerp(this._t, Math.min(1, dt * 2.2));
    this.mesh.lookAt(headPos);
    this.mesh.scale.setScalar(low ? 0.75 : 1);
    this.mesh.visible = true;
  }
}
