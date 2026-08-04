// ---------- Toggle armar/desarmar (solo existe en inicio.html) ----------
const app = document.getElementById('app');
const shieldBtn = document.getElementById('shieldBtn');

if (shieldBtn) {
  const shieldLabel = document.getElementById('shieldLabel');
  const shieldSubState = document.getElementById('shieldSubState');
  const statusPillText = document.getElementById('statusPillText');

  shieldBtn.addEventListener('click', () => {
    const armed = app.dataset.armed === 'true';
    const next = !armed;
    app.dataset.armed = String(next);
    shieldBtn.setAttribute('aria-pressed', String(next));
    shieldLabel.textContent = next ? 'ARMADO' : 'DESARMADO';
    shieldSubState.textContent = next ? 'activo' : 'en pausa';
    statusPillText.textContent = next ? 'ARMADO' : 'DESARMADO';
    sendCmd(next ? 'ARM' : 'DISARM');
    toast(next ? 'Vehículo armado' : 'Vehículo desarmado');
  });
}

// ---------- Switches genéricos (presentes en varias páginas) ----------
document.querySelectorAll('.switch').forEach(sw => {
  sw.addEventListener('click', () => sw.classList.toggle('on'));
});

// ---------- Seguros: control segmentado (solo en control.html) ----------
function setLock(locked, sendToBle = true) {
  const closedBtn = document.getElementById('lockBtnClosed');
  const openBtn = document.getElementById('lockBtnOpen');
  if (!closedBtn || !openBtn) return;
  closedBtn.classList.toggle('active', locked);
  openBtn.classList.toggle('active', !locked);
  if (sendToBle) {
    sendCmd(locked ? 'LOCK' : 'UNLOCK');
    toast(locked ? 'Seguros cerrados' : 'Seguros abiertos');
  }
}

// ---------- Vidrios: nivel visual animado (solo en control.html) ----------
const windowState = { L: 35, R: 35 };
function moveWindow(side, delta, sendToBle = true) {
  const glass = document.getElementById('glass' + side);
  const pct = document.getElementById('pct' + side);
  if (!glass || !pct) return;
  windowState[side] = Math.max(0, Math.min(100, windowState[side] + delta));
  glass.style.height = windowState[side] + '%';
  pct.textContent = windowState[side] + '%';
  if (sendToBle) {
    sendCmd('WIN_' + side + '_' + (delta > 0 ? 'UP' : 'DOWN'));
    const zona = side === 'L' ? 'delantero' : 'trasero';
    toast((delta > 0 ? 'Subiendo' : 'Bajando') + ' vidrio ' + zona + '…');
  }
}

// ---------- Luces: circuitos individuales (solo en control.html) ----------
const lightIds = ['LOWBEAM','HIGHBEAM','TURN_L','TURN_R','BRAKE','REVERSE','FOG','PARK'];
const lightState = {};
lightIds.forEach(id => lightState[id] = false);

function toggleLight(id, sendToBle = true) {
  const el = document.querySelector('.light-item[data-id="' + id + '"]');
  if (!el) return;
  const on = !lightState[id];
  lightState[id] = on;
  el.classList.toggle('on', on);
  if (sendToBle) {
    sendCmd('LIGHT:' + id + ':' + (on ? 'ON' : 'OFF'));
    const label = el.querySelector('.light-item-label').textContent;
    toast((on ? 'Encendiendo' : 'Apagando') + ' luces ' + label.toLowerCase());
  }
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
  if (!faults || faults.length === 0) {
    banner.style.display = 'none';
    return;
  }
  faults.forEach(f => {
    document.querySelectorAll('.light-item').forEach(el => {
      const label = el.querySelector('.light-item-label').textContent;
      if (f.toLowerCase().startsWith(label.toLowerCase())) el.classList.add('fault');
    });
  });
  banner.style.display = 'flex';
  text.textContent = faults.length === 1 ? faults[0] : faults.length + ' focos con posible falla';
}

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- Confirmación de apagado remoto (solo en control.html) ----------
function confirmStop() {
  if (confirm('¿Apagar el motor de forma remota? Esta acción solo se ejecuta si el vehículo está detenido.')) {
    sendCmd('STOP_ENGINE');
    toast('Solicitud de apagado enviada');
  }
}

// ==========================================================================
// CONEXIÓN BLUETOOTH REAL (Web Bluetooth API) — habla con el ESP32
// Requiere Chrome en Android o computadora. No funciona en Safari/iPhone.
// Los UUID deben coincidir exactamente con los del firmware centinela_firmware.ino
// ==========================================================================
const BLE_SERVICE    = '12345678-1234-5678-1234-56789abcdef0';
const BLE_CMD_CHAR    = '12345678-1234-5678-1234-56789abcdef1';
const BLE_STATUS_CHAR = '12345678-1234-5678-1234-56789abcdef2';

let bleDevice = null;
let bleCmdChar = null;
let bleConnected = false;

function updateLinkUI(connected) {
  const title = document.querySelector('.key-link-title');
  const sub = document.querySelector('.key-link-sub');
  const beam = document.querySelector('.beam');
  if (!title) return;
  title.textContent = connected ? 'Llave digital vinculada' : 'Toca para vincular por Bluetooth';
  sub.textContent = connected ? 'Bluetooth · conectado' : 'Sin conexión';
  if (beam) beam.style.opacity = connected ? '1' : '.35';
}

function onStatusUpdate(event) {
  try {
    const s = JSON.parse(new TextDecoder().decode(event.target.value));
    if (typeof s.armed === 'boolean' && shieldBtn) {
      app.dataset.armed = String(s.armed);
      document.getElementById('shieldLabel').textContent = s.armed ? 'ARMADO' : 'DESARMADO';
      document.getElementById('shieldSubState').textContent = s.armed ? 'activo' : 'en pausa';
      document.getElementById('statusPillText').textContent = s.armed ? 'ARMADO' : 'DESARMADO';
    }
    if (typeof s.locked === 'boolean') setLock(s.locked, false);
    if (typeof s.windowL === 'number') {
      windowState.L = s.windowL;
      const g = document.getElementById('glassL'), p = document.getElementById('pctL');
      if (g) g.style.height = s.windowL + '%';
      if (p) p.textContent = s.windowL + '%';
    }
    if (typeof s.windowR === 'number') {
      windowState.R = s.windowR;
      const g = document.getElementById('glassR'), p = document.getElementById('pctR');
      if (g) g.style.height = s.windowR + '%';
      if (p) p.textContent = s.windowR + '%';
    }
    if (s.lights && typeof s.lights === 'object') {
      Object.keys(s.lights).forEach(id => setLightRemote(id, s.lights[id]));
    }
    if (Array.isArray(s.faults)) {
      showFaults(s.faults);
    }
  } catch (err) {
    console.warn('Estado BLE inválido:', err);
  }
}

function onBleDisconnected() {
  bleConnected = false;
  updateLinkUI(false);
  toast('Se perdió la conexión Bluetooth con el vehículo');
}

async function gattConnect() {
  const server = await bleDevice.gatt.connect();
  const service = await server.getPrimaryService(BLE_SERVICE);
  bleCmdChar = await service.getCharacteristic(BLE_CMD_CHAR);
  const statusChar = await service.getCharacteristic(BLE_STATUS_CHAR);
  await statusChar.startNotifications();
  statusChar.addEventListener('characteristicvaluechanged', onStatusUpdate);
  bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
  bleConnected = true;
  updateLinkUI(true);
  toast('Vinculado con el vehículo por Bluetooth');
}

async function connectBLE() {
  if (!navigator.bluetooth) {
    toast('Este navegador no soporta Bluetooth (usa Chrome en Android)');
    return;
  }
  try {
    bleDevice = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] });
    await gattConnect();
  } catch (err) {
    toast('No se pudo vincular: ' + err.message);
  }
}

async function tryReconnectBLE() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    if (devices.length) {
      bleDevice = devices[0];
      await gattConnect();
    }
  } catch (err) { /* fuera de rango o apagado */ }
}

async function sendCmd(cmd) {
  if (!bleConnected || !bleCmdChar) {
    toast('Sin conexión Bluetooth — ve a Control para vincular');
    return;
  }
  try {
    await bleCmdChar.writeValue(new TextEncoder().encode(cmd));
  } catch (err) {
    toast('Error enviando comando: ' + err.message);
  }
}

// ---------- Gestión de teléfonos vinculados (solo en ajustes.html) ----------
async function pairNewPhone() {
  if (!bleConnected) {
    await connectBLE();
    if (!bleConnected) return;
  }
  if (confirm('¿Abrir 60 segundos para vincular un teléfono nuevo? Durante ese tiempo, cualquier teléfono que se conecte quedará autorizado.')) {
    sendCmd('PAIR_MODE');
    toast('Ventana de vinculación abierta — conecta el teléfono nuevo ahora');
  }
}

async function forgetPhones() {
  if (!bleConnected) {
    await connectBLE();
    if (!bleConnected) return;
  }
  if (confirm('¿Olvidar los 2 teléfonos vinculados? Vas a necesitar volver a vincular este mismo teléfono también.')) {
    sendCmd('FORGET_PHONES');
    toast('Teléfonos olvidados — ventana de vinculación abierta 60s');
  }
}

window.addEventListener('load', tryReconnectBLE);

// ---------- Registro del Service Worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
