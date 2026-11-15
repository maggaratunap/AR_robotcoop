// Player input from three places: the on-screen stick + buttons (phones),
// XR controllers (Quest) and the keyboard (desktop preview).
const $ = (id) => document.getElementById(id);
const DEAD = 0.15;

export class Input {
  constructor() {
    this.joy = { x: 0, y: 0 };
    this.fireHeld = false;
    this.empQueued = false;
    this.keys = new Set();
    this.xr = { x: 0, y: 0, fire: false, emp: false, sticks: false };
    this.onPrimary = () => {};
    this.onSecondary = () => {};

    const stick = $('stick'), knob = $('knob');
    let pid = null;
    const setKnob = (ev) => {
      const r = stick.getBoundingClientRect();
      const max = r.width / 2 - 20;
      let dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > max) { dx *= max / d; dy *= max / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joy.x = dx / max; this.joy.y = -dy / max;
    };
    const release = () => { pid = null; this.joy.x = this.joy.y = 0; knob.style.transform = ''; };
    stick.addEventListener('pointerdown', (ev) => { pid = ev.pointerId; stick.setPointerCapture(pid); setKnob(ev); ev.preventDefault(); });
    stick.addEventListener('pointermove', (ev) => { if (ev.pointerId === pid) setKnob(ev); });
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);

    const fire = $('btnFire');
    const fireOn = (v) => { this.fireHeld = v; fire.classList.toggle('on', v); };
    fire.addEventListener('pointerdown', (ev) => { fire.setPointerCapture(ev.pointerId); fireOn(true); ev.preventDefault(); });
    fire.addEventListener('pointerup', () => fireOn(false));
    fire.addEventListener('pointercancel', () => fireOn(false));
    $('btnEmp').addEventListener('pointerdown', (ev) => { this.empQueued = true; ev.preventDefault(); });

    $('btnPrimary').addEventListener('click', () => this.onPrimary());
    $('btnSecondary').addEventListener('click', () => this.onSecondary());

    // Keep taps on the controls from also firing WebXR "select" events.
    for (const el of [stick, fire, $('btnEmp'), $('btnPrimary'), $('btnSecondary'), $('btnExit')]) {
      el.addEventListener('beforexrselect', (ev) => ev.preventDefault());
    }

    addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement) return;
      if (ev.repeat) return;
      this.keys.add(ev.code);
      if (ev.code === 'Enter') this.onPrimary();
      if (ev.code === 'Backspace') this.onSecondary();
    });
    addEventListener('keyup', (ev) => this.keys.delete(ev.code));
    addEventListener('blur', () => this.keys.clear());
  }

  // Read thumbsticks / triggers from XR controllers.
  pollXR(session) {
    const x = this.xr;
    x.x = x.y = 0; x.fire = x.emp = false; x.sticks = false;
    if (!session) return;
    let best = 0;
    for (const src of session.inputSources) {
      // Only hand-held controllers count. On a phone every finger on the screen is
      // also an input source whose "gamepad" axes are the touch position, so reading
      // those would steer the robot whenever FIRE or EMP is pressed.
      if (src.targetRayMode !== 'tracked-pointer') continue;
      const gp = src.gamepad;
      if (!gp) continue;
      if (gp.axes.length >= 4) { // xr-standard: thumbstick on axes 2/3
        x.sticks = true;
        const ax = gp.axes[2] || 0, ay = gp.axes[3] || 0, m = Math.hypot(ax, ay);
        if (m > best) { best = m; x.x = ax; x.y = -ay; }
      }
      if (gp.buttons[0] && gp.buttons[0].pressed) x.fire = true;
      for (const b of [1, 4, 5]) if (gp.buttons[b] && gp.buttons[b].pressed) x.emp = true;
    }
  }

  state() {
    const k = this.keys;
    let x = this.joy.x + this.xr.x, y = this.joy.y + this.xr.y;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    const m = Math.hypot(x, y);
    if (m < DEAD) { x = 0; y = 0; } else if (m > 1) { x /= m; y /= m; }
    const emp = this.empQueued || this.xr.emp || k.has('KeyE');
    this.empQueued = false;
    return { x, y, fire: this.fireHeld || this.xr.fire || k.has('Space'), emp };
  }
}
