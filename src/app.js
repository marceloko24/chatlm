(() => {
  const $ = (id) => document.getElementById(id);

  const fileInput = $('file');
  const loadSaved = $('load-saved');
  const statusEl = $('status');
  const progressWrap = $('progress-wrap');
  const progressBar = $('progress-bar');
  const backendEl = $('backend');
  const modelLabel = $('model-label');
  const chat = $('chat');
  const transcript = $('transcript');
  const promptEl = $('prompt');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const resetBtn = $('reset');
  const speedEl = $('speed');
  const composer = $('composer');

  let worker = null;
  let modelLoaded = false;
  let answering = false;
  let answerBubble = null;
  let streamStarted = 0;
  let streamTokens = 0;
  let workerGeneration = 0;

  function status(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function progress(percent, show) {
    progressWrap.hidden = !show;
    if (show) progressBar.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function showSaved(meta) {
    if (!meta) {
      loadSaved.hidden = true;
      modelLabel.textContent = 'Importá un archivo GGUF desde tu iPhone. Queda guardado acá y no se sube a ningún servidor.';
      return;
    }
    const peso = formatSize(meta.size);
    const nombre = meta.name || 'modelo.gguf';
    modelLabel.textContent = 'Hay un modelo guardado en este dispositivo: ' + nombre + (peso ? ' (' + peso + ')' : '') + '. No se envió a ningún servidor.';
    loadSaved.hidden = false;
  }

  function addBubble(who, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + who;
    el.textContent = text;
    transcript.appendChild(el);
    el.scrollIntoView({ block: 'end' });
    return el;
  }

  function setAnswering(on) {
    answering = on;
    sendBtn.disabled = on || !modelLoaded;
    stopBtn.hidden = !on;
    resetBtn.disabled = on;
    fileInput.disabled = on;
    loadSaved.disabled = on;
  }

  function explainCrash(event) {
    return 'El motor se detuvo, posiblemente por falta de memoria. La interfaz sigue activa; podés importar o cargar de nuevo. ' +
      (event && event.message ? event.message : '');
  }

  function onWorkerMessage(message) {
    const { kind, text } = message;
    switch (kind) {
      case 'ready':
        backendEl.textContent = text || 'CPU, 1 hilo';
        break;
      case 'hello':
        showSaved(message.meta);
        if (!modelLoaded) status('Listo. Elegí un archivo GGUF o cargá el que ya está guardado.');
        break;
      case 'progress':
        progress(message.percent, true);
        status(message.text || text || 'Trabajando…');
        break;
      case 'status':
        status(text || '');
        if (message.progress != null) progress(message.progress, true);
        break;
      case 'saved':
        showSaved(message.meta);
        status('Modelo guardado en el dispositivo. Ahora se carga en el motor…');
        break;
      case 'loaded':
        modelLoaded = true;
        progress(0, false);
        chat.hidden = false;
        sendBtn.disabled = false;
        status(text || 'Modelo listo.', 'ok');
        backendEl.textContent = text || backendEl.textContent;
        break;
      case 'token':
        if (!answerBubble) {
          answerBubble = addBubble('assistant', '');
          streamStarted = performance.now();
          streamTokens = 0;
        }
        answerBubble.textContent += text || '';
        answerBubble.scrollIntoView({ block: 'end' });
        streamTokens += 1;
        if (streamStarted) {
          const secs = (performance.now() - streamStarted) / 1000;
          if (secs > 0) {
            speedEl.textContent = streamTokens + ' tokens · ' + (streamTokens / secs).toFixed(1) + ' tokens/s';
          }
        }
        break;
      case 'done':
        setAnswering(false);
        answerBubble = null;
        speedEl.textContent = text || speedEl.textContent;
        status('Listo.');
        break;
      case 'reset':
        transcript.replaceChildren();
        speedEl.textContent = '';
        status('Nueva charla.');
        break;
      case 'error':
        setAnswering(false);
        progress(0, false);
        answerBubble = null;
        status(text || 'Hubo un error.', 'bad');
        break;
      default:
        break;
    }
  }

  function attachWorker() {
    const gen = ++workerGeneration;
    try { if (worker) worker.terminate(); } catch (_) {}
    worker = new Worker('./worker.js');
    worker.onerror = (event) => {
      if (gen !== workerGeneration) return;
      setAnswering(false);
      progress(0, false);
      status(explainCrash(event), 'bad');
      modelLoaded = false;
      sendBtn.disabled = true;
    };
    worker.onmessage = (event) => {
      if (gen !== workerGeneration) return;
      onWorkerMessage(event.data || {});
    };
    worker.postMessage({ kind: 'hello' });
  }

  function send() {
    const text = promptEl.value.trim();
    if (!text || !modelLoaded || answering) return;
    addBubble('you', text);
    promptEl.value = '';
    answerBubble = null;
    streamTokens = 0;
    streamStarted = 0;
    speedEl.textContent = 'Generando…';
    setAnswering(true);
    status('Respondiendo…');
    worker.postMessage({ kind: 'ask', text });
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  stopBtn.addEventListener('click', () => {
    if (worker) worker.postMessage({ kind: 'stop' });
  });

  resetBtn.addEventListener('click', () => {
    if (worker) worker.postMessage({ kind: 'reset' });
  });

  promptEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file || !worker) return;
    modelLoaded = false;
    sendBtn.disabled = true;
    progress(0, true);
    status('Importando «' + file.name + '»…');
    worker.postMessage({ kind: 'import', file });
  });

  loadSaved.addEventListener('click', () => {
    if (!worker) return;
    modelLoaded = false;
    sendBtn.disabled = true;
    progress(0, true);
    status('Cargando el modelo guardado…');
    worker.postMessage({ kind: 'loadSaved' });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('service worker', err);
    });
  }

  window.__chatlmTest = {
    simulateOom() {
      if (worker) worker.postMessage({ kind: 'simulateError', code: 'oom' });
    },
    restart() {
      modelLoaded = false;
      attachWorker();
    },
  };

  attachWorker();
})();
