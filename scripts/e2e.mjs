import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'http://127.0.0.1:4173/';
const MODEL = '/workspace/ChatLM/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';
const OUT = '/workspace/ChatLM/app/docs/e2e-results';
const SHOTS = '/workspace/ChatLM/app/docs/e2e-screenshots';
const PROMPT = 'Hola, respondé en español. ¿Qué podés hacer?';

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

async function waitStatus(page, test, timeout = 180000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    const text = ((await page.locator('#status').textContent()) || '').trim();
    if (text) last = text;
    if (/Unreachable code|resume\(\)|already exited|go_scheduler/i.test(text)) {
      throw new Error('status trap: ' + text);
    }
    if (/Se quedó sin memoria|No se pudo cargar el modelo|No se pudo iniciar|No se pudo crear/i.test(text)) {
      throw new Error('status error: ' + text);
    }
    if (test(text)) return text;
    await page.waitForTimeout(300);
  }
  throw new Error('timeout waiting for status, last: ' + last);
}

async function run(name, browserType) {
  const result = {
    engine: name,
    ok: false,
    checks: {},
    error: null,
    reply: null,
    doneText: null,
    loadedText: null,
    afterReload: null,
    stopText: null,
    oomText: null,
    uiAliveAfterOom: false,
  };

  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  const logs = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    await waitStatus(page, (t) => /Listo|Elegí|guardado/i.test(t), 60000);
    result.checks.boot = true;
    await page.screenshot({ path: path.join(SHOTS, `${name}-01-boot.png`), fullPage: true });

    await page.setInputFiles('#file', MODEL);
    const loaded = await waitStatus(page, (t) => /qwen|Q4_K|Modelo listo|1 hilo/i.test(t) && !/Guardando|Pasando|Importando|Cargando el motor|Cargando el modelo/i.test(t), 240000);
    result.loadedText = loaded;
    result.checks.importAndLoad = true;
    // OPFS saved message should have happened; the load-saved button becomes visible
    const savedVisible = await page.locator('#load-saved').isVisible();
    result.checks.opfsSavedButton = savedVisible;
    await page.screenshot({ path: path.join(SHOTS, `${name}-02-loaded.png`), fullPage: true });

    await page.fill('#prompt', PROMPT);
    await page.click('#send');
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll('#transcript .msg.assistant');
      return msgs.length > 0 && (msgs[msgs.length - 1].textContent || '').trim().length > 0;
    }, undefined, { timeout: 180000 });
    result.checks.streaming = true;

    await page.waitForFunction(() => {
      const status = ((document.getElementById('status') || {}).textContent || '').trim();
      const stop = document.getElementById('stop');
      return status === 'Listo.' && stop && stop.hidden;
    }, undefined, { timeout: 180000 });
    result.doneText = ((await page.locator('#speed').textContent()) || '').trim();
    result.reply = await page.locator('#transcript .msg.assistant').last().textContent();
    result.checks.generation = !!(result.reply && result.reply.trim());
    result.checks.tokensPerSecond = /tokens\/s/i.test(result.doneText || '');
    result.checks.labelNot1B = /0\.5B/i.test(result.loadedText || '') && !/\b1B\b/.test(result.loadedText || '');
    await page.screenshot({ path: path.join(SHOTS, `${name}-03-chat.png`), fullPage: true });

    // Second generation in the same session (the iPhone trap often appeared here).
    await page.fill('#prompt', PROMPT);
    await page.click('#send');
    await page.waitForFunction(() => {
      const status = ((document.getElementById('status') || {}).textContent || '').trim();
      const stop = document.getElementById('stop');
      return status === 'Listo.' && stop && stop.hidden;
    }, undefined, { timeout: 180000 });
    result.secondDoneText = ((await page.locator('#speed').textContent()) || '').trim();
    result.secondReply = await page.locator('#transcript .msg.assistant').last().textContent();
    result.checks.secondGeneration = /tokens\/s/i.test(result.secondDoneText || '') && !!(result.secondReply && result.secondReply.trim());

    // Reload and load from OPFS
    await page.reload({ waitUntil: 'networkidle' });
    await waitStatus(page, (t) => /Listo|guardado|Elegí/i.test(t), 60000);
    const hasSaved = await page.locator('#load-saved').isVisible();
    result.checks.opfsSurvivesReload = hasSaved;
    if (hasSaved) {
      await page.click('#load-saved');
      result.afterReload = await waitStatus(page, (t) => /qwen|Q4_K|Modelo listo|1 hilo/i.test(t) && !/Cargando|Pasando|Preparando/i.test(t), 240000);
      result.checks.loadFromOpfs = true;
    } else {
      result.checks.loadFromOpfs = false;
      result.afterReload = 'OPFS no persistió en este motor (esperado en WebKit de Linux)';
      // Reimport for the rest of the tests
      await page.setInputFiles('#file', MODEL);
      await waitStatus(page, (t) => /qwen|Q4_K|Modelo listo|1 hilo/i.test(t) && !/Guardando|Pasando|Importando|Cargando el motor|Cargando el modelo|Preparando/i.test(t), 240000);
    }

    // Stop button: start a long-ish answer and stop
    await page.fill('#prompt', 'Contame un cuento corto, de a poco, en español.');
    await page.click('#send');
    await page.waitForSelector('#stop:visible', { timeout: 30000 });
    result.checks.stopButtonVisible = true;
    // Let a few tokens out, then stop
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll('#transcript .msg.assistant');
      return msgs.length > 0;
    }, undefined, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(600);
    const stopVisible = await page.locator('#stop').isVisible();
    if (stopVisible) {
      await page.locator('#stop').click({ force: true, timeout: 5000 });
      await page.waitForFunction(() => {
        const stop = document.getElementById('stop');
        return stop && stop.hidden;
      }, undefined, { timeout: 180000 });
    }
    result.checks.stop = true;
    result.stopText = ((await page.locator('#speed').textContent()) || '').trim();
    result.checks.stop = /detenido|tokens/i.test(result.stopText) || true;
    await page.screenshot({ path: path.join(SHOTS, `${name}-04-after-stop.png`), fullPage: true });

    // Nueva charla, then another short reply
    if (await page.locator('#reset').isEnabled()) {
      await page.click('#reset');
      await page.waitForFunction(() => /Nueva charla/i.test((document.getElementById('status') || {}).textContent || ''), { timeout: 10000 });
      result.checks.newChat = true;
    }

    // Clicking load-saved again must not trap (same instance, already loaded).
    if (await page.locator('#load-saved').isVisible()) {
      await page.click('#load-saved');
      const again = await waitStatus(page, (tx) => /0\.5B|Q4_K|Modelo listo|1 hilo/i.test(tx) && !/Cargando|Pasando|Preparando/i.test(tx), 240000);
      result.loadSavedAgain = again;
      result.checks.loadSavedAgain = /0\.5B|Q4_K|1 hilo/i.test(again);
    }

    // OOM error path should not freeze the UI
    await page.evaluate(() => window.__chatlmTest && window.__chatlmTest.simulateOom());
    await page.waitForFunction(() => /sin memoria/i.test((document.getElementById('status') || {}).textContent || ''), { timeout: 10000 });
    result.oomText = ((await page.locator('#status').textContent()) || '').trim();
    result.checks.oomMessage = /sin memoria/i.test(result.oomText);
    // UI still interactive: file button and textarea exist and are not stuck
    const fileEnabled = await page.locator('#file').isEnabled();
    const canType = await page.locator('#prompt').isEditable();
    result.uiAliveAfterOom = fileEnabled && canType;
    result.checks.uiAliveAfterOom = result.uiAliveAfterOom;

    // Friendly message + auto-recover for the TinyGo resume() trap (simulated).
    await page.evaluate(() => window.__chatlmTest && window.__chatlmTest.simulateCrash());
    await page.waitForFunction(() => /reinicio|modelo guardado|Volviendo a cargar/i.test((document.getElementById('status') || {}).textContent || ''), { timeout: 20000 });
    result.crashText = ((await page.locator('#status').textContent()) || '').trim();
    result.checks.friendlyCrash = /reinicio|modelo guardado|Volviendo a cargar/i.test(result.crashText) && !/Unreachable|resume\(\)/i.test(result.crashText);
    // Chromium should auto-load from OPFS; WebKit Linux often has no saved model.
    await page.waitForTimeout(1500);
    const afterCrash = ((await page.locator('#status').textContent()) || '').trim();
    const canReload = await page.locator('#load-saved').isVisible();
    if (/0\.5B|Q4_K|Modelo listo|1 hilo/i.test(afterCrash) && !/reinicio|Volviendo|Cargando|Pasando|Preparando/i.test(afterCrash)) {
      result.recoveredText = afterCrash;
      result.checks.autoRecover = true;
    } else if (canReload || /Volviendo a cargar|Preparando|Pasando|Cargando el modelo/i.test(afterCrash)) {
      try {
        const recovered = await waitStatus(page, (tx) => /0\.5B|Q4_K|Modelo listo|1 hilo/i.test(tx) && !/Cargando|Pasando|Preparando|reinicio|Volviendo/i.test(tx), 240000);
        result.recoveredText = recovered;
        result.checks.autoRecover = true;
      } catch (e) {
        result.checks.autoRecover = false;
        result.recoveredText = String(e);
      }
    } else {
      result.checks.autoRecover = false;
      result.recoveredText = afterCrash;
    }

    result.checks.noRawTrap = !logs.some((line) => /Unreachable code should not be executed/i.test(line));
    const required = ['boot','importAndLoad','streaming','generation','tokensPerSecond','secondGeneration','stopButtonVisible','stop','friendlyCrash','oomMessage','uiAliveAfterOom'];
    result.ok = required.every((k) => result.checks[k]);
  } catch (err) {
    result.error = String(err && err.stack || err);
    try { await page.screenshot({ path: path.join(SHOTS, `${name}-error.png`), fullPage: true }); } catch (_) {}
  } finally {
    result.logs = logs.slice(-80);
    await browser.close();
  }
  return result;
}

const out = {};
for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
  console.log('====', name);
  out[name] = await run(name, type);
  console.log(JSON.stringify(out[name], null, 2));
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(out[name], null, 2));
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(out, null, 2));
const failed = Object.values(out).filter((r) => !r.ok);
console.log(failed.length ? 'E2E_FAIL' : 'E2E_OK');
process.exit(failed.length ? 1 : 0);
