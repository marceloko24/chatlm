# ChatLM

PWA para charlar en el iPhone con un modelo GGUF que corre **en el dispositivo**, usando [yzma](https://github.com/hybridgroup/yzma) y llama.cpp en WebAssembly.

Las conversaciones no se envían a ningún servidor. El sitio solo entrega los archivos de la app. No hay APIs de IA externas, ni analítica, ni telemetría.

## Probarla en Safari

**https://marceloko24.github.io/chatlm/**

Código: [github.com/marceloko24/chatlm](https://github.com/marceloko24/chatlm).

1. Abrila en **Safari** (no en una pestaña privada).
2. Importá el archivo `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` desde Archivos. El modelo no se sube: queda en el teléfono.
3. Cuando termine de cargar, escribí un mensaje en español.

El 25 de noviembre de 2026, en un iPhone SE 2020 (PWA desde Inicio), la importación, OPFS y la primera respuesta en español funcionaron (~0,5 tokens/s). Después de reabrir o de «Cargar el modelo guardado» (o una segunda generación) aparecía un error crudo de TinyGo (`resume()`). Eso está corregido en esta versión, pero **la corrección todavía no se reconfirmó en el teléfono**.

## Agregar a la pantalla de inicio

1. En Safari, tocá **Compartir**.
2. Elegí **Agregar a inicio** y confirmá.

Al tenerla en Inicio, Safari no borra el modelo a los 7 días. En una pestaña normal, si pasa una semana sin usarla, el archivo guardado se puede evaporar.

## Qué hace esta versión (MVP 1.0)

- Interfaz oscura, en español, llamada ChatLM.
- Importa un GGUF con el selector de archivos de iOS (sin filtrar por un tipo MIME que iOS no conoce).
- Guarda el modelo en OPFS, en tiras de 4 MB (primero `createSyncAccessHandle` en el worker; si no está, `createWritable`). Si OPFS falla, carga el archivo solo para esa sesión.
- Carga el modelo guardado después de recargar la página. Si ya está en el motor, no lo vuelve a abrir en la misma instancia.
- Inferencia en un Web Worker, CPU de **un solo hilo**, contexto 512, lote 512. No usa WebGPU. No reserva 4 GB de memoria WASM (el tope declarado es 1 GB, y crece según hace falta desde 128 MB). El wasm de llama.cpp ya trae SIMD (`wasm32` / `simd128`); Safari lo soporta desde iOS 16.4. No hay multihilo.
- Indicador de carga, respuesta en vivo y tokens/s.
- Botón **Parar**.
- Si el motor de Go/TinyGo se detiene (trampa `resume()`), muestra un mensaje en español y reinicia el worker; si hay un modelo en OPFS, lo vuelve a cargar.
- Funciona offline una vez instalada y con el modelo ya guardado (service worker + OPFS).
- HTTPS en GitHub Pages. No pedimos COOP/COEP porque no usamos `SharedArrayBuffer`.

No incluye historial avanzado, personalidades ni varios modelos.

## Compatibilidad y límites

El detalle está en [docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md).

## Desarrollo local

Necesitás Go 1.26+, TinyGo 0.41+ y Python 3.

```
python scripts/generate_icons.py
# una sola vez, bajar el wasm de llama.cpp y recortar el tope de memoria:
go install github.com/hybridgroup/yzma@v1.33.0
yzma install -lib src/wasm -os wasm -version v1.0.0
python scripts/patch_wasm_memory.py src/wasm/yzma_wasm.wasm
rm -f src/wasm/yzma_wasm_mt.* src/wasm/yzma_wasm_webgpu.*

make dist
python3 -m http.server 4173 --directory dist --bind 127.0.0.1
```

`make` compila el programa de chat con TinyGo `-opt=2 -no-debug`. El modelo de prueba no se publica. En esta máquina está en `/workspace/ChatLM/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf`.

## Licencia

Apache 2.0, igual que yzma. Ver `LICENSE`.
