/* ChatLM inference worker: single-thread llama.cpp + TinyGo, OPFS model store. */

const MODEL_DIR = 'chatlm';
const MODEL_FILE = 'model.gguf';
const META_FILE = 'model.json';
const MEMFS_PATH = '/models/model.gguf';
const CHUNK = 4 * 1024 * 1024;

let llama = null;
let goReady = false;
let loading = false;
let asking = false;
const waiters = [];

const nativePost = self.postMessage.bind(self);

function post(message) {
  if (message && (message.kind === 'done' || message.kind === 'error' || message.kind === 'reset')) {
    asking = false;
  }
  const still = [];
  for (const waiter of waiters) {
    if (message && waiter.kinds.includes(message.kind)) {
      if (message.kind === 'error') waiter.reject(new Error(message.text || 'error'));
      else waiter.resolve(message);
    } else {
      still.push(waiter);
    }
  }
  waiters.length = 0;
  waiters.push(...still);
  nativePost(message);
}

// Go and the page both go through post().
self.postMessage = post;

function waitFor(...kinds) {
  return new Promise((resolve, reject) => {
    waiters.push({ kinds, resolve, reject });
  });
}

self.onerror = (event) => {
  post({ kind: 'error', text: mensajeMemoria(String((event && event.message) || event)) });
};
self.onunhandledrejection = (event) => {
  post({ kind: 'error', text: mensajeMemoria(String((event && event.reason) || event)) });
};

function esErrorMemoria(text) {
  const t = String(text || '');
  if (/transient reason/i.test(t)) return false;
  return /cannot enlarge memory|cannot grow memory|out of memory|Wasm memory|WebAssembly.Memory|OOM/i.test(t);
}

function mensajeMemoria(text) {
  const t = String(text || '');
  if (esErrorMemoria(t)) {
    return 'Se quedó sin memoria al cargar o usar el modelo. Cerrá otras pestañas e intentá de nuevo. El modelo no se envió a ningún servidor.';
  }
  return t;
}

async function ensureLlama() {
  if (llama) return llama;

  post({ kind: 'status', text: 'Cargando el motor (un hilo, CPU)…' });

  importScripts('./wasm/yzma_wasm.js');
  const factory = self.yzmaModule;
  if (typeof factory !== 'function') {
    throw new Error('No se encontró el módulo de llama.cpp.');
  }

  self.yzmaThreads = 1;
  self.yzmaThreaded = false;
  self.yzmaBackend = 'cpu';

  llama = await factory({
    locateFile: (name) => new URL('./wasm/' + name, self.location).href,
    print: () => {},
    printErr: (text) => {
      if (text) console.warn(text);
    },
  });
  self.yzmaModule = llama;
  self.yzmaReady = Promise.resolve(llama);
  return llama;
}

async function ensureGo() {
  if (goReady) return;
  await ensureLlama();

  importScripts('./wasm/wasm_exec.js');
  const go = new Go();
  const wasmUrl = new URL('./wasm/yzma.wasm', self.location);
  const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
  const ready = waitFor('ready', 'error');
  go.run(result.instance);
  await ready;
  if (typeof self.yzmaOpenModel !== 'function') {
    throw new Error('El programa no publicó sus funciones.');
  }
  goReady = true;
}

async function opfsRoot() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new Error('Este navegador no permite guardar el modelo en el dispositivo (falta OPFS).');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MODEL_DIR, { create: true });
}

async function writeChunksToHandle(handle, source, onProgress) {
  const total = source.size;
  let written = 0;

  if (typeof handle.createSyncAccessHandle === 'function') {
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      for (let offset = 0; offset < total; offset += CHUNK) {
        const blob = source.slice(offset, Math.min(offset + CHUNK, total));
        const buf = new Uint8Array(await blob.arrayBuffer());
        const n = access.write(buf, { at: written });
        written += n;
        if (onProgress) onProgress(written, total);
      }
      access.flush();
    } finally {
      access.close();
    }
    return;
  }

  if (typeof handle.createWritable === 'function') {
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      for (let offset = 0; offset < total; offset += CHUNK) {
        const blob = source.slice(offset, Math.min(offset + CHUNK, total));
        const buf = await blob.arrayBuffer();
        await writable.write(buf);
        written += buf.byteLength;
        if (onProgress) onProgress(written, total);
      }
      await writable.close();
    } catch (err) {
      try { await writable.abort(); } catch (_) {}
      throw err;
    }
    return;
  }

  throw new Error('No hay forma de escribir en OPFS en este navegador (ni createWritable ni createSyncAccessHandle).');
}

async function writeOpfsChunked(file, onProgress) {
  const dir = await opfsRoot();
  const handle = await dir.getFileHandle(MODEL_FILE, { create: true });
  await writeChunksToHandle(handle, file, onProgress);

  const meta = {
    name: file.name || MODEL_FILE,
    size: file.size,
    savedAt: new Date().toISOString(),
  };
  const metaHandle = await dir.getFileHandle(META_FILE, { create: true });
  const metaBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
  await writeChunksToHandle(metaHandle, metaBlob, null);
  return meta;
}

async function readMeta() {
  try {
    const dir = await opfsRoot();
    const handle = await dir.getFileHandle(META_FILE);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch (_) {
    try {
      const dir = await opfsRoot();
      const handle = await dir.getFileHandle(MODEL_FILE);
      const file = await handle.getFile();
      return { name: MODEL_FILE, size: file.size, savedAt: null };
    } catch {
      return null;
    }
  }
}

async function openOpfsModelFile() {
  const dir = await opfsRoot();
  const handle = await dir.getFileHandle(MODEL_FILE);
  return handle.getFile();
}

async function copyFileToMemfs(file, onProgress) {
  const module = await ensureLlama();
  const fs = module.FS;
  if (!fs) throw new Error('El motor no expone un sistema de archivos.');

  try { fs.mkdirTree('/models'); } catch (_) {}
  try { fs.unlink(MEMFS_PATH); } catch (_) {}

  const stream = fs.open(MEMFS_PATH, 'w+');
  const total = file.size;
  let written = 0;
  try {
    for (let offset = 0; offset < total; offset += CHUNK) {
      const blob = file.slice(offset, Math.min(offset + CHUNK, total));
      const buf = new Uint8Array(await blob.arrayBuffer());
      fs.write(stream, buf, 0, buf.length, written);
      written += buf.length;
      if (onProgress) onProgress(written, total);
    }
  } catch (err) {
    throw new Error(mensajeMemoria(err && err.message ? err.message : String(err)));
  } finally {
    try { fs.close(stream); } catch (_) {}
  }
  if (written !== total) {
    throw new Error('La copia del modelo quedó incompleta (' + written + ' de ' + total + ' bytes).');
  }
}

function percent(done, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done * 100) / total)));
}

async function importAndLoad(file) {
  if (!file) throw new Error('No llegó ningún archivo.');
  loading = true;
  try {
    post({ kind: 'status', text: 'Guardando el modelo en el dispositivo…', progress: 0, phase: 'opfs' });
    let persisted = false;
    try {
      const meta = await writeOpfsChunked(file, (done, total) => {
        post({
          kind: 'progress',
          phase: 'opfs',
          percent: percent(done, total),
          text: 'Guardando en el dispositivo… ' + percent(done, total) + '%',
        });
      });
      post({ kind: 'saved', meta });
      persisted = true;
    } catch (err) {
      const raw = err && err.message ? err.message : String(err);
      console.warn('OPFS no disponible, cargo el archivo solo para esta sesión:', raw);
      post({
        kind: 'status',
        text: 'No pude guardar el modelo en el dispositivo. Lo cargo solo para esta sesión. ' + mensajeMemoria(raw),
      });
    }
    if (persisted) {
      await loadFromOpfs();
      return;
    }
    await ensureGo();
    post({ kind: 'status', text: 'Preparando el modelo en memoria…', progress: 0, phase: 'memfs' });
    await copyFileToMemfs(file, (done, total) => {
      post({
        kind: 'progress',
        phase: 'memfs',
        percent: percent(done, total),
        text: 'Pasando el modelo al motor… ' + percent(done, total) + '%',
      });
    });
    const loaded = waitFor('loaded', 'error');
    self.yzmaOpenModel(MEMFS_PATH);
    await loaded;
  } finally {
    loading = false;
  }
}

async function loadFromOpfs() {
  loading = true;
  try {
    await ensureGo();
    post({ kind: 'status', text: 'Preparando el modelo en memoria…', progress: 0, phase: 'memfs' });
    const file = await openOpfsModelFile();
    await copyFileToMemfs(file, (done, total) => {
      post({
        kind: 'progress',
        phase: 'memfs',
        percent: percent(done, total),
        text: 'Pasando el modelo al motor… ' + percent(done, total) + '%',
      });
    });
    const loaded = waitFor('loaded', 'error');
    self.yzmaOpenModel(MEMFS_PATH);
    await loaded;
  } finally {
    loading = false;
  }
}

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.kind === 'hello') {
      await ensureGo();
      const meta = await readMeta();
      post({ kind: 'hello', meta });
      return;
    }
    if (message.kind === 'import') {
      if (loading || asking) return;
      await importAndLoad(message.file);
      return;
    }
    if (message.kind === 'loadSaved') {
      if (loading || asking) return;
      await loadFromOpfs();
      return;
    }
    if (message.kind === 'ask') {
      await ensureGo();
      if (typeof self.yzmaAsk !== 'function') throw new Error('El motor todavía no está listo.');
      asking = true;
      if (message.system) self.yzmaSetSystem(message.system);
      self.yzmaAsk(message.text);
      return;
    }
    if (message.kind === 'stop') {
      if (typeof self.yzmaStop === 'function') self.yzmaStop();
      return;
    }
    if (message.kind === 'reset') {
      if (typeof self.yzmaReset === 'function') self.yzmaReset();
      return;
    }
    if (message.kind === 'simulateError' && message.code === 'oom') {
      post({ kind: 'error', text: mensajeMemoria('out of memory (prueba)') });
      return;
    }
    post({ kind: 'error', text: 'Mensaje desconocido: ' + message.kind });
  } catch (err) {
    asking = false;
    loading = false;
    post({ kind: 'error', text: mensajeMemoria(err && err.message ? err.message : String(err)) });
  }
};
