// ==========================================================================
// UUIDs — deben coincidir con centinela_firmware.ino
// ==========================================================================
const BLE_SERVICE    = '12345678-1234-5678-1234-56789abcdef0';
const BLE_CMD_CHAR    = '12345678-1234-5678-1234-56789abcdef1';
const BLE_STATUS_CHAR = '12345678-1234-5678-1234-56789abcdef2';

const app = document.getElementById('app');

// ==========================================================================
// Toast
// ==========================================================================
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ==========================================================================
// Router SPA
// ==========================================================================
const VALID_SCREENS = ['inicio','mapa','control','camara','ajustes'];
function showScreen(name, push = true) {
  if (!VALID_SCREENS.includes(name)) name = 'inicio';
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
  if (push) history.pushState({ screen: name }, '', '#' + name);
  Sound.play('tap');
}
document.querySelectorAll('.tab, [data-goto]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    showScreen(el.dataset.screen || el.dataset.goto);
  });
});
window.addEventListener('popstate', (e) => showScreen(e.state && e.state.screen ? e.state.screen : 'inicio', false));
showScreen((location.hash || '#inicio').slice(1), false);
history.replaceState({ screen: (location.hash || '#inicio').slice(1) }, '');

// ==========================================================================
// Sonidos
// ==========================================================================
const Sound = {
  ctx: null,
  enabled: localStorage.getItem('centinela_sound') !== 'off',
  ensureCtx() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return this.ctx; },
  beep(freq, dur, type = 'sine', gain = 0.05) {
    if (!this.enabled) return;
    try {
      const ctx = this.ensureCtx();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type; osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g); g.connect(ctx.destination);
      osc.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.stop(ctx.currentTime + dur);
    } catch (err) { /* audio no disponible */ }
  },
  play(name) {
    switch (name) {
      case 'tap': this.beep(500, .04, 'sine', .02); break;
      case 'arm': this.beep(880, .12); this.beep(1180, .12); break;
      case 'disarm': this.beep(660, .12); break;
      case 'lock': this.beep(740, .08); break;
      case 'unlock': this.beep(520, .08); break;
      case 'connect': this.beep(600, .08); this.beep(900, .12); break;
      case 'disconnect': this.beep(400, .18, 'sawtooth', .03); break;
      case 'error': this.beep(220, .22, 'square', .04); break;
      case 'ok': this.beep(760, .1); break;
    }
  },
  toggle(el) {
    this.enabled = !this.enabled;
    el.classList.toggle('on', this.enabled);
    localStorage.setItem('centinela_sound', this.enabled ? 'on' : 'off');
    if (this.enabled) this.play('ok');
  }
};
document.getElementById('switchSound').classList.toggle('on', Sound.enabled);

// ==========================================================================
// Bloqueo de la app con configuración inicial obligatoria
// ==========================================================================
const AppLock = {
  biometricEnabled: localStorage.getItem('centinela_bio') === 'on',
  credentialId: localStorage.getItem('centinela_cred_id'),
  pinHash: localStorage.getItem('centinela_pin_hash'),
  pendingResolve: null,
  pinBuffer: '',
  _pinMode: '',
  _pinFirst: '',
  _afterSetupConfirm: false,

  async sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  supportsWebAuthn() {
    return window.PublicKeyCredential && navigator.credentials;
  },

  refreshSettingsUI() {
    document.getElementById('switchBiometric').classList.toggle('on', this.biometricEnabled);
    document.getElementById('bioStatusSub').textContent = this.biometricEnabled ? 'Activo en este teléfono' : 'Usa el lector de tu teléfono';
    document.getElementById('pinStatusSub').textContent = this.pinHash ? 'Configurado' : 'No configurado';
  },

  async setupBiometric() {
    if (!this.supportsWebAuthn()) {
      toast('Este navegador no soporta desbloqueo biométrico');
      return;
    }
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'Centinela' },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'conductor', displayName: 'Conductor' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          timeout: 60000
        }
      });
      this.credentialId = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
      localStorage.setItem('centinela_cred_id', this.credentialId);
      this.biometricEnabled = true;
      localStorage.setItem('centinela_bio', 'on');
      toast('Huella/rostro configurado');
      Sound.play('ok');
      this.refreshSettingsUI();
      this.checkSecurityConfigured();
    } catch (err) {
      toast('No se pudo configurar: ' + err.message);
    }
  },

  async toggleBiometric(el) {
    if (this.biometricEnabled) {
      this.biometricEnabled = false;
      localStorage.setItem('centinela_bio', 'off');
      this.refreshSettingsUI();
      return;
    }
    this.setupBiometric();
  },

  isSecurityConfigured() {
    return this.biometricEnabled || (this.pinHash && this.pinHash.length > 0);
  },

  checkSecurityConfigured() {
    if (this.isSecurityConfigured()) {
      document.getElementById('configOverlay').hidden = true;
      document.getElementById('keyLinkCard').style.pointerEvents = 'auto';
      document.getElementById('keyLinkCard').style.opacity = '1';
      toast('Seguridad configurada. Ahora puedes vincular tu teléfono.');
    } else {
      document.getElementById('configOverlay').hidden = false;
      document.getElementById('keyLinkCard').style.pointerEvents = 'none';
      document.getElementById('keyLinkCard').style.opacity = '0.5';
    }
  },

  async tryBiometricUnlock() {
    if (!this.biometricEnabled || !this.supportsWebAuthn()) { this.openPinEntry(); return; }
    try {
      await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: Uint8Array.from(atob(this.credentialId), c => c.charCodeAt(0)), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      this.onUnlockSuccess();
    } catch (err) {
      toast('No se reconoció la huella/rostro — intenta de nuevo o usa PIN');
    }
  },

  onUnlockSuccess() {
    document.getElementById('lockOverlay').hidden = true;
    this.closePinOverlay();
    Sound.play('ok');
    if (this.pendingResolve) { const r = this.pendingResolve; this.pendingResolve = null; r(true); }
  },

  showLockScreenIfNeeded() {
    if (!this.isSecurityConfigured()) {
      document.getElementById('configOverlay').hidden = false;
      document.getElementById('keyLinkCard').style.pointerEvents = 'none';
      document.getElementById('keyLinkCard').style.opacity = '0.5';
      return;
    }
    document.getElementById('configOverlay').hidden = true;
    document.getElementById('keyLinkCard').style.pointerEvents = 'auto';
    document.getElementById('keyLinkCard').style.opacity = '1';
    if (this.biometricEnabled || this.pinHash) {
      document.getElementById('lockOverlay').hidden = false;
      if (this.biometricEnabled) this.tryBiometricUnlock();
    }
  },

  confirm(reason) {
    return new Promise(async (resolve) => {
      if (!this.isSecurityConfigured()) {
        toast('Primero debes configurar la seguridad');
        this.showLockScreenIfNeeded();
        resolve(false);
        return;
      }
      this.pendingResolve = resolve;
      document.getElementById('pinOverlayTitle').textContent = 'Confirma tu identidad';
      document.getElementById('pinOverlaySub').textContent = reason || 'Necesario para continuar';
      if (this.biometricEnabled) {
        await this.tryBiometricUnlock();
      } else {
        this.openPinEntry();
      }
    });
  },

  openPinSetup(afterConfirm = false) {
    this.pinBuffer = '';
    this._pinMode = 'setup-1';
    this._pinFirst = '';
    document.getElementById('pinOverlayTitle').textContent = 'Crea un PIN';
    document.getElementById('pinOverlaySub').textContent = 'Se usará para desbloquear la app y vincular teléfonos';
    document.getElementById('pinError').textContent = '';
    this.renderPinDots();
    document.getElementById('pinOverlay').hidden = false;
    this._afterSetupConfirm = afterConfirm;
  },

  openPinEntry() {
    this.pinBuffer = '';
    this._pinMode = 'verify';
    document.getElementById('pinOverlayTitle').textContent = 'Ingresa tu PIN';
    document.getElementById('pinOverlaySub').textContent = 'Toca los números para desbloquear';
    document.getElementById('pinError').textContent = '';
    this.renderPinDots();
    document.getElementById('pinOverlay').hidden = false;
  },

  closePinOverlay() {
    document.getElementById('pinOverlay').hidden = true;
    if (this.pendingResolve && this._pinMode === 'verify') {
      const r = this.pendingResolve; this.pendingResolve = null; r(false);
    }
  },

  renderPinDots() {
    document.querySelectorAll('#pinDots span').forEach((dot, i) => dot.classList.toggle('filled', i < this.pinBuffer.length));
  },

  async pinPress(n) {
    if (this.pinBuffer.length >= 4) return;
    this.pinBuffer += String(n);
    this.renderPinDots();
    if (this.pinBuffer.length < 4) return;

    if (this._pinMode === 'setup-1') {
      this._pinFirst = this.pinBuffer;
      this.pinBuffer = '';
      this._pinMode = 'setup-2';
      document.getElementById('pinOverlaySub').textContent = 'Confirma el PIN otra vez';
      this.renderPinDots();
      return;
    }
    if (this._pinMode === 'setup-2') {
      if (this.pinBuffer !== this._pinFirst) {
        document.getElementById('pinError').textContent = 'No coincide, intenta de nuevo';
        this.pinBuffer = ''; this._pinMode = 'setup-1'; this._pinFirst = '';
        this.renderPinDots();
        return;
      }
      this.pinHash = await this.sha256(this.pinBuffer);
      localStorage.setItem('centinela_pin_hash', this.pinHash);
      this.refreshSettingsUI();
      toast('PIN configurado');
      document.getElementById('pinOverlay').hidden = true;
      this.checkSecurityConfigured();
      if (this._afterSetupConfirm) { this.onUnlockSuccess(); }
      return;
    }
    if (this._pinMode === 'verify') {
      const hash = await this.sha256(this.pinBuffer);
      if (hash === this.pinHash) {
        this.onUnlockSuccess();
      } else {
        document.getElementById('pinError').textContent = 'PIN incorrecto';
        Sound.play('error');
        this.pinBuffer = '';
        this.renderPinDots();
      }
    }
  },

  pinBackspace() {
    this.pinBuffer = this.pinBuffer.slice(0, -1);
    document.getElementById('pinError').textContent = '';
    this.renderPinDots();
  }
};

AppLock.refreshSettingsUI();
AppLock.checkSecurityConfigured();
AppLock.showLockScreenIfNeeded();

// ==========================================================================
// Módulo BLE – real, sin simulaciones
// ==========================================================================
const BLE = {
  device: null, cmdChar: null, statusChar: null, connected: false,

  updateLinkUI() {
    const pill = document.getElementById('statusPill');
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusPillText');
    const title = document.getElementById('keyLinkTitle');
    const sub = document.getElementById('keyLinkSub');
    const beam = document.getElementById('beam');
    pill.classList.toggle('on', this.connected);
    if (title) title.textContent = this.connected ? 'Llave digital vinculada' : 'Toca para vincular por Bluetooth';
    if (sub) sub.textContent = this.connected ? 'Bluetooth · conectado' : 'Sin conexión';
    if (beam) beam.style.opacity = this.connected ? '1' : '.35';
    if (!this.connected) { text.textContent = 'Sin conexión'; return; }
    text.textContent = app.dataset.armed === 'true' ? 'ARMADO' : 'DESARMADO';
  },

  onStatusUpdate(event) {
    try {
      const s = JSON.parse(new TextDecoder().decode(event.target.value));
      if (typeof s.armed === 'boolean') {
        app.dataset.armed = String(s.armed);
        const label = document.getElementById('shieldLabel'), sub = document.getElementById('shieldSubState');
        if (label) label.textContent = s.armed ? 'ARMADO' : 'DESARMADO';
        if (sub) sub.textContent = s.armed ? 'activo' : 'en pausa';
      }
      if (typeof s.locked === 'boolean') setLock(s.locked, false);
      if (typeof s.windowL === 'number') { windowState.L = s.windowL; setGlass('L', s.windowL); }
      if (typeof s.windowR === 'number') { windowState.R = s.windowR; setGlass('R', s.windowR); }
      if (s.lights && typeof s.lights === 'object') Object.keys(s.lights).forEach(id => setLightRemote(id, s.lights[id]));
      if (Array.isArray(s.faults)) showFaults(s.faults);
      BLE.updateLinkUI();
    } catch (err) { /* estado no válido */ }
  },

  onDisconnected() {
    BLE.connected = false;
    BLE.updateLinkUI();
    Sound.play('disconnect');
    toast('Se perdió la conexión Bluetooth con el vehículo');
    Proximity.stop();
  },

  async gattConnect() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    this.cmdChar = await service.getCharacteristic(BLE_CMD_CHAR);
    this.statusChar = await service.getCharacteristic(BLE_STATUS_CHAR);
    await this.statusChar.startNotifications();
    this.statusChar.addEventListener('characteristicvaluechanged', this.onStatusUpdate);
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.connected = true;
    this.updateLinkUI();
    Sound.play('connect');
    toast('Vinculado con el vehículo por Bluetooth');
    if (Proximity.enabled) Proximity.start();
  },

  async connect() {
    if (!navigator.bluetooth) {
      toast('Este navegador no soporta Bluetooth (usa Chrome en Android)');
      return;
    }
    try {
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] });
      await this.gattConnect();
    } catch (err) {
      Sound.play('error');
      toast('No se pudo vincular: ' + err.message);
    }
  },

  async tryReconnect() {
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
    try {
      const devices = await navigator.bluetooth.getDevices();
      if (devices.length) { this.device = devices[0]; await this.gattConnect(); }
    } catch (err) { /* fuera de rango o apagado */ }
  },

  async send(cmd) {
    if (!this.connected || !this.cmdChar) { 
      toast('Sin conexión Bluetooth con el vehículo');
      return false;
    }
    try {
      await this.cmdChar.writeValue(new TextEncoder().encode(cmd));
      return true;
    } catch (err) {
      Sound.play('error');
      toast('Error enviando comando: ' + err.message);
      return false;
    }
  }
};
window.addEventListener('load', () => BLE.tryReconnect());

async function pairPhoneSecure() {
  if (BLE.connected) return;
  const ok = await AppLock.confirm('Confirma para vincular el teléfono por Bluetooth');
  if (!ok) return;
  await BLE.connect();
}

// ==========================================================================
// Proximidad real (solo si BLE.connected)
// ==========================================================================
const Proximity = {
  enabled: localStorage.getItem('centinela_proximity') === 'on',
  sensitivity: Number(localStorage.getItem('centinela_proximity_level') || 3),
  watching: false,
  lastState: null,
  debounceTimer: null,

  levels: { 1: -50, 2: -60, 3: -70, 4: -80, 5: -90 },
  labels: { 1: 'Muy cerca', 2: 'Cerca', 3: 'Media', 4: 'Lejos', 5: 'Muy lejos' },

  init() {
    document.getElementById('switchProximity').classList.toggle('on', this.enabled);
    document.getElementById('proximitySlider').value = this.sensitivity;
    document.getElementById('proximityValLabel').textContent = this.labels[this.sensitivity];
  },

  toggle(el) {
    this.enabled = !this.enabled;
    el.classList.toggle('on', this.enabled);
    localStorage.setItem('centinela_proximity', this.enabled ? 'on' : 'off');
    if (this.enabled && BLE.connected) this.start(); else this.stop();
  },

  setSensitivity(val) {
    this.sensitivity = Number(val);
    localStorage.setItem('centinela_proximity_level', String(this.sensitivity));
    document.getElementById('proximityValLabel').textContent = this.labels[this.sensitivity];
  },

  async start() {
    if (this.watching || !this.enabled || !BLE.connected || !BLE.device) return;
    if (!BLE.device.watchAdvertisements) {
      toast('Tu navegador no soporta lectura de señal en segundo plano');
      return;
    }
    try {
      BLE.device.addEventListener('advertisementreceived', (e) => this.handleAdvertisement(e));
      await BLE.device.watchAdvertisements();
      this.watching = true;
      document.getElementById('proximityLiveCard').style.display = 'block';
    } catch (err) {
      toast('No se pudo activar la proximidad: ' + err.message);
    }
  },

  stop() {
    this.watching = false;
    document.getElementById('proximityLiveCard').style.display = 'none';
  },

  handleAdvertisement(event) {
    const rssi = event.rssi;
    if (typeof rssi !== 'number') return;
    const label = document.getElementById('proximityRssiLabel');
    if (label) label.textContent = rssi + ' dBm';

    const threshold = this.levels[this.sensitivity];
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (rssi >= threshold + 8 && this.lastState !== 'near') {
        this.lastState = 'near';
        if (app.dataset.armed === 'true') { doDisarm(); toast('Vehículo desarmado por proximidad'); }
      } else if (rssi <= threshold - 8 && this.lastState !== 'far') {
        this.lastState = 'far';
        if (app.dataset.armed !== 'true') { doArm(); toast('Vehículo armado por alejamiento'); }
      }
    }, 1500);
  }
};
Proximity.init();

// ==========================================================================
// Armado / desarmado
// ==========================================================================
const shieldBtn = document.getElementById('shieldBtn');
const shieldLabel = document.getElementById('shieldLabel');
const shieldSubState = document.getElementById('shieldSubState');

function doArm() {
  app.dataset.armed = 'true';
  shieldBtn.setAttribute('aria-pressed', 'true');
  shieldLabel.textContent = 'ARMADO'; shieldSubState.textContent = 'activo';
  BLE.updateLinkUI();
  BLE.send('ARM');
  Sound.play('arm');
}
function doDisarm() {
  app.dataset.armed = 'false';
  shieldBtn.setAttribute('aria-pressed', 'false');
  shieldLabel.textContent = 'DESARMADO'; shieldSubState.textContent = 'en pausa';
  BLE.updateLinkUI();
  BLE.send('DISARM');
  Sound.play('disarm');
}
shieldBtn.addEventListener('click', () => {
  const armed = app.dataset.armed === 'true';
  if (armed) doDisarm(); else doArm();
  toast(armed ? 'Vehículo desarmado' : 'Vehículo armado');
});

// ==========================================================================
// Seguros
// ==========================================================================
function setLock(locked, sendToBle = true) {
  const closedBtn = document.getElementById('lockBtnClosed');
  const openBtn = document.getElementById('lockBtnOpen');
  if (!closedBtn || !openBtn) return;
  closedBtn.classList.toggle('active', locked);
  openBtn.classList.toggle('active', !locked);
  if (sendToBle) {
    BLE.send(locked ? 'LOCK' : 'UNLOCK');
    Sound.play(locked ? 'lock' : 'unlock');
    toast(locked ? 'Seguros cerrados' : 'Seguros abiertos');
  }
}

// ==========================================================================
// Vidrios
// ==========================================================================
const windowState = { L: 35, R: 35 };
function setGlass(side, pct) {
  const glass = document.getElementById('glass' + side);
  const label = document.getElementById('pct' + side);
  if (glass) glass.style.height = pct + '%';
  if (label) label.textContent = pct + '%';
}
function moveWindow(side, delta) {
  windowState[side] = Math.max(0, Math.min(100, windowState[side] + delta));
  setGlass(side, windowState[side]);
  BLE.send('WIN_' + side + '_' + (delta > 0 ? 'UP' : 'DOWN'));
  const zona = side === 'L' ? 'delantero' : 'trasero';
  toast((delta > 0 ? 'Subiendo' : 'Bajando') + ' vidrio ' + zona + '…');
}

// ==========================================================================
// Luces
// ==========================================================================
const lightIds = ['LOWBEAM','HIGHBEAM','TURN_L','TURN_R','BRAKE','REVERSE','FOG','PARK'];
const lightState = {};
lightIds.forEach(id => lightState[id] = false);

function toggleLight(id) {
  const el = document.querySelector('.light-item[data-id="' + id + '"]');
  if (!el) return;
  const on = !lightState[id];
  lightState[id] = on;
  el.classList.toggle('on', on);
  BLE.send('LIGHT:' + id + ':' + (on ? 'ON' : 'OFF'));
  const label = el.querySelector('.light-item-label').textContent;
  toast((on ? 'Encendiendo' : 'Apagando') + ' luces ' + label.toLowerCase());
}
function setLightRemote(id, on) {
  const el = document.querySelector('.light-item[data-id="' + id + '"]');
  if (!el) return;
  lightState[id] = on;
  el.classList.toggle('on', on);
}
function showFaults(faults) {
  const banner = document.getElementById('lightFaultBanner');
  const text = document.getElementById('lightFaultText');
  if (!banner || !text) return;
  document.querySelectorAll('.light-item').forEach(el => el.classList.remove('fault'));
  if (!faults || faults.length === 0) { banner.style.display = 'none'; return; }
  faults.forEach(f => {
    document.querySelectorAll('.light-item').forEach(el => {
      const label = el.querySelector('.light-item-label').textContent;
      if (f.toLowerCase().startsWith(label.toLowerCase())) el.classList.add('fault');
    });
  });
  banner.style.display = 'flex';
  text.textContent = faults.length === 1 ? faults[0] : faults.length + ' focos con posible falla';
}

// ==========================================================================
// Otras acciones
// ==========================================================================
function sendCmd(cmd, msg) {
  BLE.send(cmd);
  Sound.play('ok');
  if (msg) toast(msg);
}
function confirmStop() {
  if (confirm('¿Apagar el motor de forma remota? Esta acción solo se ejecuta si el vehículo está detenido.')) {
    BLE.send('STOP_ENGINE');
    Sound.play('ok');
    toast('Solicitud de apagado enviada');
  }
}

// ==========================================================================
// Gestión de teléfonos vinculados
// ==========================================================================
async function pairNewPhone() {
  const ok = await AppLock.confirm('Confirma para abrir la vinculación de un teléfono nuevo');
  if (!ok) return;
  if (!BLE.connected) { await BLE.connect(); if (!BLE.connected) return; }
  if (confirm('¿Abrir 60 segundos para vincular un teléfono nuevo? Durante ese tiempo, cualquier teléfono que se conecte quedará autorizado.')) {
    BLE.send('PAIR_MODE');
    toast('Ventana de vinculación abierta — conecta el teléfono nuevo ahora');
  }
}
async function forgetPhonesSecure() {
  const ok = await AppLock.confirm('Confirma para olvidar todos los teléfonos vinculados');
  if (!ok) return;
  if (!BLE.connected) { await BLE.connect(); if (!BLE.connected) return; }
  if (confirm('¿Olvidar los 2 teléfonos vinculados? Vas a necesitar volver a vincular este mismo teléfono también.')) {
    BLE.send('FORGET_PHONES');
    toast('Teléfonos olvidados — ventana de vinculación abierta 60s');
  }
}

// ==========================================================================
// Interruptores genéricos decorativos
// ==========================================================================
document.querySelectorAll('.switch').forEach(sw => {
  if (['switchBiometric','switchProximity','switchSound'].includes(sw.id)) return;
  sw.addEventListener('click', () => sw.classList.toggle('on'));
});

// ==========================================================================
// Service Worker (opcional)
// ==========================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
