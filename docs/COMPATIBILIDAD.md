# ChatLM — Compatibilidad, límites y qué está verificado

Informe del 25 de noviembre de 2026, hora de Uruguay (UTC-3). Pruebas locales alrededor de las 01:42.

No se afirma que ChatLM funcione en Safari del iPhone SE 2020 hasta probarlo en ese aparato. Playwright WebKit en Linux no es Safari de iOS.

## Cómo está armada

- Motor: yzma v1.33.0 + llama.cpp v1.0.0 en WebAssembly, **solo** el build de CPU de un hilo (sin WebGPU y sin hilos / SharedArrayBuffer).
- Programa de chat: Go compilado con TinyGo 0.44, contexto 512, hasta 128 tokens por respuesta. Entre tokens se cede el event loop para que Parar y el pintado en vivo funcionen.
- Memoria WASM de llama.cpp: inicial 128 MB, máximo declarado **1 GB** (no 4 GB), con crecimiento.
- El modelo vive en OPFS y se copia al MEMFS del motor en tiras de 4 MB, sin meter el archivo entero en un solo ArrayBuffer.
- El sitio no pide encabezados COOP/COEP. Un service worker guarda la cáscara para usar la app sin red, una vez instalada.
- No hay llamadas a APIs de IA, ni analítica, ni CDN de fuentes o scripts.

## Pruebas en esta computadora (Debian 13)

Modelo usado: `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (397,8 MB), importado con `<input type="file">`. No se publicó el GGUF.

Herramientas: Playwright 1.65.1, Chromium 159 y WebKit 27.2, servidor estático local en `http://127.0.0.1:4173/`.

### Chromium 159 (Playwright, Linux) — verificado

- Arranque de la PWA, importación, escritura en OPFS, carga en el motor (`qwen2 1B Q4_K - Medium, CPU, 1 hilo, contexto 512`).
- Recargar la página y volver a cargar el modelo desde OPFS.
- Respuesta en español, en vivo, con tokens/s. Ejemplo: «Hola, puedo ayudarte a responder o hacer cualquier otra cosa. ¿En qué te puedo asistir hoy?» (23 tokens, 1,5 tokens/s en esta máquina).
- Botón Parar: detuvo la generación («4 tokens, 0,3 tokens/s, detenido»).
- El mensaje de “sin memoria” (vía una prueba controlada, no un tope real de WASM) no congela la interfaz: se puede seguir usando el selector y el cuadro de texto.

### Playwright WebKit 27.2 (Linux) — parcial

- Este motor **no es Safari de iOS**. Se presenta como Safari 27.2 de macOS.
- En este entorno, OPFS responde `UnknownError: The operation failed for an unknown transient reason (e.g. out of memory)`. No es un tope de RAM de un iPhone; es una limitación de WebKit en Linux.
- La app, en ese caso, carga el GGUF solo para la sesión (sin persistir). Con esa vía se verificó: carga del modelo, respuesta en español en vivo («Hola! Podemos conversar, pedir ayuda, hacer tareas. ¿Cómo puedo ayudarte hoy?», 22 tokens, 1,1 tokens/s), botón Parar («4 tokens, 0,3 tokens/s, detenido») y que el error de memoria simulado no congela la UI.

### Safari de iOS en iPhone SE 2020 — no verificado

Falta probar en el teléfono: importar desde Archivos, persistir en OPFS, sobrevivir a un recargo, generar, parar, agregar a Inicio, modo avión y que Safari no cierre la pestaña por memoria.

## Funciones, una por una

| Función | Estado |
| --- | --- |
| Interfaz oscura en español, nombre ChatLM | Verificado en Chromium y WebKit Linux |
| Importar GGUF (selector de archivos, sin MIME restrictivo) | Verificado en Chromium y WebKit Linux (el archivo se eligió con Playwright, no con el selector de iOS) |
| Compatible con Qwen2.5-0.5B-Instruct-Q4_K_M.gguf | Verificado en Chromium y WebKit Linux (carga y genera). En WebKit Linux, OPFS no persistió |
| Guardar en OPFS por bloques | Verificado en Chromium. En WebKit Linux, OPFS no está usable. En iPhone, no verificado |
| No cargar el archivo entero en un ArrayBuffer | Verificado en el código (tiras de 4 MB) y ejercido al importar |
| Cargar el modelo desde el almacenamiento local | Verificado en Chromium (recarga + «Cargar el modelo guardado»). No verificado en iOS |
| Inferencia solo en el dispositivo, sin APIs externas | Verificado en el diseño y en las pruebas locales (no hay red hacia un modelo). En producción el hosting solo sirve la app |
| Indicador de carga del modelo | Verificado en Chromium y WebKit Linux |
| Respuesta en vivo y tokens/s | Verificado en Chromium y WebKit Linux |
| Botón Parar | Verificado en Chromium y WebKit Linux |
| PWA: manifest, service worker, offline | Verificado a nivel de archivos y registro del SW en el navegador de prueba. Offline real y URL pública: se confirma al publicar |
| HTTPS | Queda verificado cuando GitHub Pages publique la URL |
| COOP/COEP | No aplican (build de un hilo, sin SharedArrayBuffer) |
| WebGPU | No se usa, a propósito |
| Instrucciones «Agregar a inicio» | Están en la app y en el README, en español. El gesto en el iPhone no está verificado |
| Manejo de error de memoria sin congelar la UI | Verificado en Chromium y WebKit Linux con una simulación de error. Un corte real de pestaña en iOS no se puede simular acá |
| Safari de iOS / iPhone SE 2020 | **No verificado** |

## Riesgos en el iPhone SE 2020

- 3 GB de RAM. Safari puede cerrar la pestaña al cargar un GGUF de ~400 MB más el motor. El tope de 1 GB busca evitar el fallo clásico de pedir 2–4 GB, pero no garantiza que entre.
- Si no se agrega a Inicio, Safari puede borrar el modelo a los 7 días sin uso.
- Navegación privada no sirve para dejarlo instalado.
- El modelo de 0,5B a veces responde corto o se va de tema.
- En iOS, `createWritable` puede faltar: por eso el worker prefiere `createSyncAccessHandle`.
- La velocidad en las pruebas de escritorio fue de alrededor de 1–1,5 tokens/s; en el iPhone puede ser distinta (mejor o peor) y no está medida.
