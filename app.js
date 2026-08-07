/* ============================================================
   CENTINELA - app.js
   Lógica de la PWA: conexión Bluetooth Web con el ESP32,
   bloqueo de la app (huella/rostro + PIN), y control remoto
   del vehículo (seguros, vidrios, luces, motor, sirena, etc).

   Coincide con el firmware "CENTINELA v3.2":
     SERVICE_UUID : 12345678-1234-5678-1234-56789abcdef0
     CMD_UUID     : 12345678-1234-5678-1234-56789abcdef1 (write)
     STATUS_UUID  : 12345678-1234-5678-1234-56789abcdef2 (notify)
   ============================================================ */

(() => {
  "use strict";

  // ======================== CONFIG BLE ========================
  const SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
  const CMD_UUID     = "12345678-1234-5678-1234-56789abcdef1";
  const STATUS_UUID  = "12345678-1234-5678-1234-56789abcdef2";

  const BLE_SUPPORTED = !!(navigator.bluetooth);

  // ======================== ESTADO GLOBAL ========================
  const state = {
    device: null,
    server: null,
    cmdChar: null,
    statusChar: null,
    connected: false,
    connecting: false,
    vehicle: {
      armed: true,
      locked: true,
      engine: false,
      doorOpen: false,
      parked: true,
      battery: 12.6,
      windowL: 35,
      windowR: 35,
      lights: {}
    }
  };

  // ======================== UTILIDADES ========================
  const $ = (id) => document.getElementById(id);

  function showToast(msg, type = "ok") {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show " + type;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
    Sound.play(type);
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function setLastActivity() {
    const el = $("lastActivity");
    if (el) el.textContent = "justo ahora";
  }

  // ======================== NAVEGACIÓN ENTRE PANTALLAS ========================
  
function goToScreen(name) {
  const current = document.querySelector(".screen.active");
  const next = document.querySelector(`.screen[data-screen="${name}"]`);
  if (!next || next === current) return;

  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.screen === name));

  const showNext = () => {
    next.classList.add("active", "entering");
    const clearEnter = () => next.classList.remove("entering");
    next.addEventListener("animationend", clearEnter, { once: true });
    setTimeout(clearEnter, 300); // respaldo por si animationend no dispara
  };

  if (current) {
    current.classList.add("exiting");
    const finishExit = () => {
      current.classList.remove("active", "exiting");
      showNext();
    };
    current.addEventListener("animationend", finishExit, { once: true });
    setTimeout(finishExit, 200); // respaldo
  } else {
    showNext();
  }
}
  function initNavigation() {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        goToScreen(tab.dataset.screen);
      });
    });
    document.querySelectorAll("[data-goto]").forEach(link => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        goToScreen(link.dataset.goto);
      });
    });
  }

  // ======================== BLUETOOTH ========================
  const Vehicle = {
    async connect() {
      if (!BLE_SUPPORTED) {
        showToast("Este navegador no soporta Bluetooth Web. Usa Chrome/Edge en Android.", "warn");
        return false;
      }
      if (state.connecting) return false;
      state.connecting = true;
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [SERVICE_UUID] }],
          optionalServices: [SERVICE_UUID]
        });
        state.device = device;
        device.addEventListener("gattserverdisconnected", Vehicle.onDisconnected);

        showToast("Vinculando con el vehículo…", "ok");
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const cmdChar = await service.getCharacteristic(CMD_UUID);
        const statusChar = await service.getCharacteristic(STATUS_UUID);

        await statusChar.startNotifications();
        statusChar.addEventListener("characteristicvaluechanged", Vehicle.onStatusNotify);

        state.server = server;
        state.cmdChar = cmdChar;
        state.statusChar = statusChar;
        state.connected = true;

        // Leer estado inicial
        try {
          const val = await statusChar.readValue();
          Vehicle.applyStatus(val);
        } catch (_) { /* algunos firmwares solo notifican, está bien */ }

        Vehicle.updateConnectionUI();
        showToast("Teléfono conectado al vehículo", "ok");
        return true;
      } catch (err) {
        console.error(err);
        if (err.name !== "NotFoundError") {
          showToast("No se pudo vincular: " + err.message, "warn");
        }
        return false;
      } finally {
        state.connecting = false;
      }
    },

    onDisconnected() {
      state.connected = false;
      state.cmdChar = null;
      state.statusChar = null;
      Vehicle.updateConnectionUI();
      showToast("Se perdió la conexión con el vehículo", "warn");
    },

    onStatusNotify(event) {
      Vehicle.applyStatus(event.target.value);
    },

    applyStatus(dataView) {
      try {
        const text = new TextDecoder().decode(dataView.buffer ? dataView : dataView.value);
        const data = JSON.parse(text);
        Object.assign(state.vehicle, {
          armed: !!data.armed,
          locked: !!data.locked,
          engine: !!data.engine,
          doorOpen: !!data.doorOpen,
          parked: !!data.parked,
          battery: typeof data.battery === "number" ? data.battery : state.vehicle.battery,
          windowL: typeof data.windowL === "number" ? data.windowL : state.vehicle.windowL,
          windowR: typeof data.windowR === "number" ? data.windowR : state.vehicle.windowR,
          lights: data.lights || state.vehicle.lights
        });
        if (data.ack && data.message) {
          showToast(data.message, data.ok ? "ok" : "warn");
        }
        Vehicle.updateVehicleUI();
        setLastActivity();
      } catch (e) {
        console.warn("Estado BLE ilegible:", e);
      }
    },

    async send(cmd, okLabel) {
      if (!state.connected || !state.cmdChar) {
        const ok = await Vehicle.connect();
        if (!ok || !state.cmdChar) {
          showToast("Vincula tu teléfono primero", "warn");
          return false;
        }
      }
      try {
        await state.cmdChar.writeValue(new TextEncoder().encode(cmd));
        if (okLabel) showToast(okLabel, "ok");
        setLastActivity();
        return true;
      } catch (err) {
        console.error(err);
        showToast("No se pudo enviar el comando", "warn");
        return false;
      }
    },

    updateConnectionUI() {
      const pill = $("statusPill");
      const dot = $("statusDot");
      const pillText = $("statusPillText");
      const keyTitle = $("keyLinkTitle");
      const keySub = $("keyLinkSub");
      const beam = $("beam");

      if (state.connected) {
        pill?.classList.add("connected");
        dot?.classList.add("on");
        if (pillText) pillText.textContent = "Conectado";
        if (keyTitle) keyTitle.textContent = "Vinculado con el vehículo";
        if (keySub) keySub.textContent = "Bluetooth activo";
        if (beam) beam.style.opacity = "1";
      } else {
        pill?.classList.remove("connected");
        dot?.classList.remove("on");
        if (pillText) pillText.textContent = "Sin conexión";
        if (keyTitle) keyTitle.textContent = "Toca para vincular por Bluetooth";
        if (keySub) keySub.textContent = "Sin conexión";
        if (beam) beam.style.opacity = ".35";
      }
    },

    updateVehicleUI() {
      const v = state.vehicle;

      // Escudo (armado/desarmado)
      const app = $("app");
      const shieldLabel = $("shieldLabel");
      const shieldSubState = $("shieldSubState");
      app?.setAttribute("data-armed", v.armed ? "true" : "false");
      if (shieldLabel) shieldLabel.textContent = v.armed ? "ARMADO" : "DESARMADO";
      if (shieldSubState) shieldSubState.textContent = v.armed ? "activo" : "en pausa";

      // Seguros
      $("lockBtnClosed")?.classList.toggle("active", v.locked);
      $("lockBtnOpen")?.classList.toggle("active", !v.locked);

      // Vidrios
      const glassL = $("glassL"), glassR = $("glassR");
      const pctL = $("pctL"), pctR = $("pctR");
      if (glassL) glassL.style.height = v.windowL + "%";
      if (glassR) glassR.style.height = v.windowR + "%";
      if (pctL) pctL.textContent = v.windowL + "%";
      if (pctR) pctR.textContent = v.windowR + "%";

      // Luces
      document.querySelectorAll(".light-item").forEach(btn => {
        const id = btn.dataset.id;
        btn.classList.toggle("active", !!v.lights[id]);
      });
    }
  };

  // Comandos usados desde el HTML
  window.pairPhoneSecure = async function () {
    AppLock.requireAuth(async () => {
      await Vehicle.connect();
    }, "Confirma tu identidad para vincular un teléfono");
  };

  window.pairNewPhone = function () {
    if (!state.connected) {
      showToast("Primero conecta el teléfono ya vinculado", "warn");
      return;
    }
    AppLock.requireAuth(async () => {
      await Vehicle.send("PAIR_MODE", "Modo de vinculación abierto por 60 s");
    }, "Confirma tu identidad para abrir un espacio nuevo");
  };

  window.forgetPhonesSecure = function () {
    AppLock.requireAuth(() => {
      if (!confirm("Esto olvidará los 2 teléfonos vinculados y tendrás que emparejar de nuevo. ¿Continuar?")) return;
      Vehicle.send("FORGET_PHONES", "Teléfonos olvidados; vinculación abierta");
    }, "Confirma tu identidad para olvidar los teléfonos");
  };

  window.setLock = function (closed) {
    Vehicle.send(closed ? "LOCK" : "UNLOCK", closed ? "Seguros cerrados" : "Seguros abiertos");
  };

  window.moveWindow = function (side, delta) {
    const dir = delta > 0 ? "UP" : "DOWN";
    const cmd = "WIN_" + side + "_" + dir;
    Vehicle.send(cmd);
  };

  window.toggleLight = function (id) {
    const isOn = !!state.vehicle.lights[id];
    Vehicle.send("LIGHT:" + id + ":" + (isOn ? "OFF" : "ON"));
  };

  window.sendCmd = function (cmd, label) {
    Vehicle.send(cmd, label);
  };

  window.confirmStop = function () {
    if (!confirm("¿Apagar el motor de forma remota? Solo funciona con el vehículo detenido.")) return;
    Vehicle.send("STOP_ENGINE", "Motor apagado");
  };

  function initShieldButton() {
    $("shieldBtn")?.addEventListener("click", () => {
      const willArm = !state.vehicle.armed;
      Vehicle.send(willArm ? "ARM" : "DISARM", willArm ? "Vehículo armado" : "Vehículo desarmado");
    });
  }

  // ======================== BLOQUEO DE APP (AppLock) ========================
  const LOCK_KEY = "centinela_lock_cfg";

  function loadLockCfg() {
    try { return JSON.parse(localStorage.getItem(LOCK_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function saveLockCfg(cfg) {
    localStorage.setItem(LOCK_KEY, JSON.stringify(cfg));
  }

  const AppLock = {
    cfg: loadLockCfg(),
    unlocked: false,
    pendingPin: "",
    pinMode: null,       // 'setup' | 'confirm-setup' | 'unlock' | 'auth'
    firstPinEntry: "",
    onAuthSuccess: null,

    init() {
      this.refreshSettingsUI();
      if (!this.cfg.biometric && !this.cfg.pinHash) {
        $("configOverlay").hidden = false;
      } else {
        this.lockApp();
      }
    },

    refreshSettingsUI() {
      $("switchBiometric")?.classList.toggle("on", !!this.cfg.biometric);
      const bioSub = $("bioStatusSub");
      if (bioSub) bioSub.textContent = this.cfg.biometric ? "Activado" : "Usa el lector de tu teléfono";
      const pinSub = $("pinStatusSub");
      if (pinSub) pinSub.textContent = this.cfg.pinHash ? "Configurado" : "No configurado";
    },

    lockApp() {
      this.unlocked = false;
      $("lockOverlay").hidden = false;
      $("configOverlay").hidden = true;
    },

    unlockApp() {
      this.unlocked = true;
      $("lockOverlay").hidden = true;
      $("configOverlay").hidden = true;
    },

    async setupBiometric() {
      if (!window.PublicKeyCredential) {
        showToast("Tu navegador no soporta huella/rostro (WebAuthn)", "warn");
        return;
      }
      try {
        await navigator.credentials.create({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { name: "Centinela" },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: "conductor@centinela.app",
              displayName: "Conductor Centinela"
            },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
            timeout: 60000
          }
        });
        this.cfg.biometric = true;
        saveLockCfg(this.cfg);
        this.refreshSettingsUI();
        showToast("Huella / rostro configurado", "ok");
        $("configOverlay").hidden = true;
        this.unlockApp();
      } catch (err) {
        console.error(err);
        showToast("No se pudo configurar huella/rostro", "warn");
      }
    },

    toggleBiometric(el) {
      if (this.cfg.biometric) {
        if (!this.cfg.pinHash && !confirm("Sin PIN de respaldo no podrás entrar si falla la huella. ¿Desactivar de todos modos?")) return;
        this.cfg.biometric = false;
        saveLockCfg(this.cfg);
        el.classList.remove("on");
        this.refreshSettingsUI();
      } else {
        this.setupBiometric();
      }
    },

    async tryBiometricUnlock() {
      if (!this.cfg.biometric || !window.PublicKeyCredential) {
        showToast("Huella/rostro no configurado, usa tu PIN", "warn");
        return;
      }
      try {
        await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            userVerification: "required",
            timeout: 60000
          }
        });
        this.unlockApp();
        if (this.onAuthSuccess) { const fn = this.onAuthSuccess; this.onAuthSuccess = null; fn(); }
      } catch (err) {
        showToast("No se reconoció tu huella/rostro", "warn");
      }
    },

    // ---- PIN ----
    openPinSetup() {
      this.pinMode = this.cfg.pinHash ? "confirm-setup" : "setup";
      this.firstPinEntry = "";
      this.pendingPin = "";
      $("pinOverlayTitle").textContent = "Crea tu PIN";
      $("pinOverlaySub").textContent = "4 dígitos para desbloquear Centinela";
      $("pinError").textContent = "";
      this.renderPinDots();
      $("pinOverlay").hidden = false;
    },

    openPinEntry() {
      this.pinMode = "unlock";
      this.pendingPin = "";
      $("pinOverlayTitle").textContent = "Ingresa tu PIN";
      $("pinOverlaySub").textContent = "Por seguridad, confirma con tu PIN";
      $("pinError").textContent = "";
      this.renderPinDots();
      $("pinOverlay").hidden = false;
    },

    requireAuth(callback, subtitle) {
      // Si la app no tiene ningún candado configurado (no debería pasar), permite directo
      if (!this.cfg.biometric && !this.cfg.pinHash) { callback(); return; }
      this.onAuthSuccess = callback;
      if (this.cfg.biometric) {
        $("lockOverlay").querySelector(".lock-sub").textContent = subtitle || "Usa tu huella o rostro para continuar";
        $("lockOverlay").hidden = false;
      } else {
        this.pinMode = "auth";
        this.pendingPin = "";
        $("pinOverlayTitle").textContent = "Confirma tu PIN";
        $("pinOverlaySub").textContent = subtitle || "Por seguridad, confirma con tu PIN";
        $("pinError").textContent = "";
        this.renderPinDots();
        $("pinOverlay").hidden = false;
      }
    },

    renderPinDots() {
      const dots = $("pinDots")?.querySelectorAll("span");
      if (!dots) return;
      dots.forEach((dot, i) => dot.classList.toggle("filled", i < this.pendingPin.length));
    },

    async pinPress(n) {
      if (this.pendingPin.length >= 4) return;
      this.pendingPin += String(n);
      this.renderPinDots();
      if (this.pendingPin.length === 4) await this.completePinEntry();
    },

    pinBackspace() {
      this.pendingPin = this.pendingPin.slice(0, -1);
      this.renderPinDots();
      $("pinError").textContent = "";
    },

    async completePinEntry() {
      const pin = this.pendingPin;
      const hash = await sha256Hex(pin);

      if (this.pinMode === "setup") {
        this.firstPinEntry = hash;
        this.pendingPin = "";
        this.pinMode = "confirm-new";
        $("pinOverlayTitle").textContent = "Confirma tu PIN";
        $("pinOverlaySub").textContent = "Vuelve a ingresarlo";
        this.renderPinDots();
        return;
      }

      if (this.pinMode === "confirm-new") {
        if (hash !== this.firstPinEntry) {
          $("pinError").textContent = "Los PIN no coinciden. Intenta de nuevo.";
          this.pendingPin = "";
          this.pinMode = "setup";
          $("pinOverlayTitle").textContent = "Crea tu PIN";
          $("pinOverlaySub").textContent = "4 dígitos para desbloquear Centinela";
          this.renderPinDots();
          return;
        }
        this.cfg.pinHash = hash;
        saveLockCfg(this.cfg);
        this.refreshSettingsUI();
        this.closePinOverlay();
        showToast("PIN configurado", "ok");
        $("configOverlay").hidden = true;
        this.unlockApp();
        return;
      }

      if (this.pinMode === "confirm-setup") {
        // Cambiar PIN existente: valida el actual primero
        if (hash !== this.cfg.pinHash) {
          $("pinError").textContent = "PIN incorrecto";
          this.pendingPin = "";
          this.renderPinDots();
          return;
        }
        this.pinMode = "setup";
        this.pendingPin = "";
        $("pinOverlayTitle").textContent = "Crea tu nuevo PIN";
        $("pinOverlaySub").textContent = "4 dígitos nuevos";
        this.renderPinDots();
        return;
      }

      if (this.pinMode === "unlock" || this.pinMode === "auth") {
        if (hash !== this.cfg.pinHash) {
          $("pinError").textContent = "PIN incorrecto";
          this.pendingPin = "";
          this.renderPinDots();
          return;
        }
        const wasAuth = this.pinMode === "auth";
        this.closePinOverlay();
        this.unlockApp();
        if (wasAuth && this.onAuthSuccess) {
          const fn = this.onAuthSuccess; this.onAuthSuccess = null; fn();
        }
        return;
      }
    },

    closePinOverlay() {
      $("pinOverlay").hidden = true;
      this.pendingPin = "";
      this.pinMode = null;
    }
  };
  window.AppLock = AppLock;

  // ======================== PROXIMIDAD ========================
  const PROX_KEY = "centinela_proximity";
  const Proximity = {
    cfg: JSON.parse(localStorage.getItem(PROX_KEY) || "{}"),
    watching: false,

    save() { localStorage.setItem(PROX_KEY, JSON.stringify(this.cfg)); },

    init() {
      $("switchProximity")?.classList.toggle("on", !!this.cfg.enabled);
      const v = this.cfg.sensitivity || 3;
      const slider = $("proximitySlider");
      if (slider) slider.value = v;
      this.setSensitivity(v, false);
    },

    toggle(el) {
      this.cfg.enabled = !this.cfg.enabled;
      this.save();
      el.classList.toggle("on", this.cfg.enabled);
      $("proximityLiveCard").style.display = this.cfg.enabled ? "block" : "none";
      if (this.cfg.enabled) this.startWatching();
      else this.stopWatching();
    },

    setSensitivity(val, save = true) {
      this.cfg.sensitivity = Number(val);
      if (save) this.save();
      const labels = ["", "Muy cerca", "Cerca", "Media", "Lejos", "Muy lejos"];
      const el = $("proximityValLabel");
      if (el) el.textContent = labels[this.cfg.sensitivity] || "Media";
    },

    async startWatching() {
      if (this.watching) return;
      if (!("watchAdvertisements" in BluetoothDevice.prototype || {})) {
        showToast("Tu navegador no soporta monitoreo de proximidad en segundo plano", "warn");
        return;
      }
      if (!state.device) {
        showToast("Vincula el vehículo primero para activar proximidad", "warn");
        return;
      }
      try {
        state.device.addEventListener("advertisementreceived", (evt) => {
          if (typeof evt.rssi === "number") {
            const el = $("proximityRssiLabel");
            if (el) el.textContent = evt.rssi + " dBm";
          }
        });
        await state.device.watchAdvertisements();
        this.watching = true;
      } catch (err) {
        console.warn(err);
      }
    },

    stopWatching() {
      this.watching = false;
    }
  };
  window.Proximity = Proximity;

  // ======================== SONIDO ========================
  const SOUND_KEY = "centinela_sound";
  const Sound = {
    enabled: localStorage.getItem(SOUND_KEY) !== "off",
    ctx: null,

    init() {
      $("switchSound")?.classList.toggle("on", this.enabled);
    },

    toggle(el) {
      this.enabled = !this.enabled;
      localStorage.setItem(SOUND_KEY, this.enabled ? "on" : "off");
      el.classList.toggle("on", this.enabled);
    },

    play(type) {
      if (!this.enabled) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = type === "warn" ? 220 : 880;
        gain.gain.value = 0.06;
        osc.connect(gain).connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + 0.12);
      } catch (_) { /* audio no disponible, ignorar */ }
    }
  };
  window.Sound = Sound;

  // ======================== ARRANQUE ========================
  document.addEventListener("DOMContentLoaded", () => {
    initNavigation();
    initShieldButton();
    Vehicle.updateConnectionUI();
    Vehicle.updateVehicleUI();
    Proximity.init();
    Sound.init();
    AppLock.init();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  });
})();
