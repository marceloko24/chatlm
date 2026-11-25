# ChatLM

PWA para charlar en el iPhone con un modelo GGUF que corre **en el dispositivo**, usando [yzma](https://github.com/hybridgroup/yzma) y llama.cpp en WebAssembly.

Las conversaciones no se envían a ningún servidor. El sitio solo entrega los archivos de la app. No hay APIs de IA externas, ni analítica, ni telemetría.

**No afirmamos que funcione en Safari de iOS hasta probarlo en el iPhone físico.** En esta versión se comprobó en Chromium y en Playwright WebKit de Linux.

## Probarla en Safari

La URL prevista es:

**https://marceloko24.github.io/chatlm/**

Todavía no está en línea. El código ya está en [github.com/marceloko24/chatlm](https://github.com/marceloko24/chatlm) y el *build* de GitHub Actions terminó bien (25 de noviembre de 2026, ~01:47 hora de Uruguay). El *deploy* falló porque GitHub Pages no está activado en el repositorio; el conector no puede cambiar esa opción.

Activación (una sola vez, en el iPhone, ya entrado a GitHub; no hace falta compartir contraseña ni un código):

1. Abrí [la configuración de Pages del repo](https://github.com/marceloko24/chatlm/settings/pages).
2. En *Build and deployment* → *Source*, elegí **GitHub Actions** y guardá.
3. En la pestaña Actions, re-ejecutá el flujo *pages* (o avisá y lo re-ejecutamos).

Cuando la URL responda:

1. Abrila en **Safari** (no en una pestaña privada).
2. Importá el archivo `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` desde Archivos. El modelo no se sube: queda en el teléfono.
3. Cuando termine de cargar, escribí un mensaje en español.

## Agregar a la pantalla de inicio

1. En Safari, tocá **Compartir**.
2. Elegí **Agregar a inicio** y confirmá.

Al tenerla en Inicio, Safari no borra el modelo a los 7 días. En una pestaña normal, si pasa una semana sin usarla, el archivo guardado se puede evaporar.

## Qué hace esta versión (MVP 1.0)

- Interfaz oscura, en español, llamada ChatLM.
- Importa un GGUF con el selector de archivos de iOS (sin filtrar por un tipo MIME que iOS no conoce).
- Guarda el modelo en OPFS, en tiras de 4 MB (primero `createSyncAccessHandle` en el worker; si no está, `createWritable`). Si OPFS falla, carga el archivo solo para esa sesión.
- Carga el modelo guardado después de recargar la página.
- Inferencia en un Web Worker, CPU de **un solo hilo**, contexto 512. No usa WebGPU. No reserva 4 GB de memoria WASM (el tope declarado es 1 GB, y crece según hace falta desde 128 MB).
- Indicador de carga, respuesta en vivo y tokens/s.
- Botón **Parar**.
- Funciona offline una vez instalada y con el modelo ya guardado (service worker + OPFS).
- HTTPS en GitHub Pages. No pedimos COOP/COEP porque no usamos `SharedArrayBuffer`.

No incluye historial avanzado, personalidades ni varios modelos.

## Compatibilidad y límites

El detalle está en [docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md). En resumen:

- Pensada para Safari en un iPhone SE 2020 (3 GB de RAM). Eso **no está verificado** en el aparato.
- El motor es un modelo chico (Qwen 2.5 0.5B). Las respuestas pueden ser cortas o flojas.
- En Playwright WebKit de Linux, OPFS falla con un `UnknownError` (no es Safari de iOS). En ese caso la app carga el GGUF solo para la sesión. En Chromium, OPFS sí persistió y sobrevivió a una recarga.
- El 25 de noviembre de 2026 (hora de Uruguay, UTC-3) se verificó en ambos motores: importar el GGUF, generar una respuesta en español en vivo con tokens/s, el botón Parar, y que un error de memoria simulado no congela la interfaz.

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

El modelo de prueba no se publica. En esta máquina está en `/workspace/ChatLM/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf`.

## Licencia

Apache 2.0, igual que yzma. Ver `LICENSE`.
