# VOLT/16

Groovebox para móvil y ordenador: batería de inspiración 808, bajo monofónico y dos secuenciadores de 16 pasos. El audio se genera en el navegador con Web Audio, sin muestras ni servidor de audio.

**[Abrir VOLT/16 en Netlify](https://volt-16-live-drum-machine-synth-bass.netlify.app/)** · [Código en GitHub](https://github.com/sergiodevece/VOLT-16)

## Tocar

1. Abre la app y pulsa **PLAY** para iniciar el audio.
2. Programa los pasos en **BATERÍA** y **BAJO**; ajusta el sonido del bajo en **SÍNTESIS**.
3. En **MEZCLA**, ajusta volumen, panorama, compresión y ecualización de cada canal.
4. En **FX**, selecciona el canal y ajusta sus envíos a los efectos.

Durante la reproducción, editar batería o bajo modifica el patrón sin disparar golpes o notas adicionales. En pausa se pueden preescuchar ambos.

## Sonido y controles

- Batería: bombo, caja, palmas, charles cerrado y abierto.
- Bajo: oscilador, suboscilador, filtro, envolvente, acento y slide.
- Tempo, tap tempo y swing.
- Por canal: compresor de inspiración óptica con gain y peak reduction; EQ con pasa altos, pasa bajos y dos shelving.
- Delay de cinta/digital, reverb room/plate/hall, phaser, chorus y flanger.
- Envíos, activación y parámetros de cada efecto independientes para los seis canales.

El sonido sale por la salida de audio que tenga seleccionada el dispositivo. Los patrones y ajustes se reinician al recargar la página.

## Ejecutar en local

No necesita instalación de paquetes ni compilación. Desde la carpeta del proyecto:

```sh
python3 -m http.server 8000 --directory dist
```

Abre `http://localhost:8000` y pulsa PLAY. El modo sin conexión se activa cuando la app se sirve por HTTPS y ha cargado sus archivos al menos una vez.

## Publicar en GitHub Pages

1. El repositorio de este proyecto es `sergiodevece/VOLT-16`, con la rama principal `main`.
2. En **Settings → Pages → Build and deployment → Source**, elige **GitHub Actions**.
3. Sube el contenido de este proyecto, incluidas las carpetas `dist`, `tests` y `.github`.
4. En **Actions**, comprueba que termina correctamente **Publicar VOLT/16**. El despliegue mostrará el enlace de la app.

El flujo incluido comprueba JavaScript y las pruebas de audio antes de publicar exclusivamente la carpeta `dist`. Los siguientes cambios en `main` volverán a publicar la app. También se puede iniciar desde **Actions → Publicar VOLT/16 → Run workflow**.

La configuración sigue la [guía oficial de GitHub Pages con Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Comprobaciones

Con Node.js 18 o posterior:

```sh
node --check dist/app.js
node --check dist/sw.js
node --test tests/*.test.cjs
```

Las pruebas comprueban aislamiento por canal, lifecycle y cleanup de los cinco efectos, STOP y `pagehide`, continuidad de envolventes, gestión de notas, recuperación del secuenciador y aislamiento de la caché. Incluyen diez minutos simulados a 190 BPM y un escenario con los cinco efectos activos en los seis canales, cambios repetidos, desactivación/reactivación y PLAY/STOP. Son simulaciones de gestión de recursos y señal; no miden la RAM ni los cortes del hilo de audio de Safari/Chrome. La escucha en dispositivos reales sigue siendo necesaria.

## Arquitectura de audio r8

- Cada canal conserva su propio estado, envío y ruta FX. Cambiar los parámetros de un canal no modifica los nodos de los demás.
- Delay, chorus, phaser y flanger se crean bajo demanda y se desconectan después de sus colas. Sus LFO se detienen durante el cleanup.
- La reverb prepara una sola vez tres impulsos y tres convolvers compartidos. Cada canal activo aporta su propio send, damping y ganancias de selección room/plate/hall.
- Con los efectos apagados no existen procesadores ni envíos permanentes por canal. STOP retira rutas, timers y LFO, y cada voz terminada desconecta sus nodos.
- Los controles sustituyen su automatización anterior conservando el valor alcanzado y omiten objetivos repetidos.
- El filtro del delay usa una Q sin resonancia para que el feedback máximo permitido no amplifique sucesivamente algunas frecuencias. En los filtros lowpass/highpass de Web Audio, Q se expresa en dB: [especificación de los filtros](https://www.w3.org/TR/webaudio/#filters-characteristics).
- El osciloscopio reutiliza su buffer, los medidores se actualizan como máximo a 30 fps y su animación se detiene cuando no están visibles. Editar un paso de batería actualiza solamente ese botón.

Para la prueba auditiva, confirma que el pie de la app muestra **AUDIO r8**. Prueba 10–15 minutos editando patrones, usando parámetros FX distintos en varios canales y haciendo PLAY/STOP repetidos. Si hay crujidos, anota dispositivo, navegador, efecto y ajuste que los provoca, y si desaparecen al recargar.
