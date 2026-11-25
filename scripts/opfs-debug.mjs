import { webkit, chromium } from 'playwright';

async function test(name, type) {
  const browser = await type.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(name, 'CONS', msg.text()));
  page.on('pageerror', (err) => console.log(name, 'ERR', err.message));
  await page.goto('http://127.0.0.1:4173/');
  const info = await page.evaluate(async () => {
    const out = { worker: null };
    try {
      out.hasStorage = !!(navigator.storage && navigator.storage.getDirectory);
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('chatlm-debug', { create: true });
      const h = await dir.getFileHandle('t.bin', { create: true });
      out.createWritable = typeof h.createWritable;
      out.createSyncAccessHandle = typeof h.createSyncAccessHandle;
      const data = new Uint8Array(1024 * 1024);
      data.fill(7);
      if (typeof h.createWritable === 'function') {
        try {
          const w = await h.createWritable();
          await w.write(data.buffer);
          await w.close();
          out.writableWrite = 'ok';
        } catch (e) {
          out.writableWrite = String(e);
        }
      }
    } catch (e) {
      out.mainError = String(e);
    }
    // worker test
    out.worker = await new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([`
        self.onmessage = async () => {
          const out = {};
          try {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('chatlm-debug', { create: true });
            const h = await dir.getFileHandle('t2.bin', { create: true });
            out.createWritable = typeof h.createWritable;
            out.createSyncAccessHandle = typeof h.createSyncAccessHandle;
            const data = new Uint8Array(2 * 1024 * 1024);
            data.fill(3);
            if (typeof h.createSyncAccessHandle === 'function') {
              try {
                const a = await h.createSyncAccessHandle();
                a.truncate(0);
                const n = a.write(data, { at: 0 });
                a.flush();
                a.close();
                out.syncWrite = 'ok ' + n;
              } catch (e) { out.syncWrite = String(e); }
            }
            if (typeof h.createWritable === 'function') {
              try {
                const w = await h.createWritable();
                await w.write(data);
                await w.close();
                out.writableWrite = 'ok';
              } catch (e) { out.writableWrite = String(e); }
            }
          } catch (e) { out.error = String(e); }
          self.postMessage(out);
        };
      `], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve({ workerError: e.message });
      w.postMessage('go');
    });
    return out;
  });
  console.log(name, JSON.stringify(info, null, 2));
  await browser.close();
}

await test('webkit', webkit);
await test('chromium', chromium);
