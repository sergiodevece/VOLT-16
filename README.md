# VOLT/16

Groovebox para móvil y ordenador: batería de inspiración 808, bajo monofónico, polisinte J-4 de cuatro voces y dos secuenciadores de 16 pasos. El audio se genera en el navegador con Web Audio, sin muestras ni servidor de audio.

**[Abrir VOLT/16 en Netlify](https://volt-16-live-drum-machine-synth-bass.netlify.app/)** · [Código en GitHub](https://github.com/sergiodevece/VOLT-16)

## Tocar

1. Abre la app y pulsa **PLAY** para iniciar el audio.
2. Programa los pasos en **BATERÍA** y **BAJO**; ajusta el sonido del bajo en **SÍNTESIS**.
3. En **JUNO**, toca el J-4 polifónico desde su teclado de dos octavas y edita DCO, filtro, envolvente, LFO y chorus.
4. En **MEZCLA**, ajusta volumen, panorama, compresión y ecualización de cada canal.
5. En **FX**, selecciona el canal y ajusta sus envíos a los efectos.

Durante la reproducción, editar batería o bajo modifica el patrón sin disparar golpes o notas adicionales. En pausa se pueden preescuchar ambos.

## Sonido y controles

- Batería: bombo, caja, palmas, charles cerrado y abierto.
- Bajo: oscilador, suboscilador, filtro, envolvente, acento, slide y Auto Cutoff sincronizado al BPM.
- J-4: cuatro voces, saw, pulse con PWM, suboscilador, HPF, filtro de 24 dB, ADSR, LFO y chorus estéreo OFF/I/II/I+II.
- Tempo, tap tempo y swing.
- Por canal: compresor de inspiración óptica con gain y peak reduction; EQ con pasa altos, pasa bajos y dos shelving.
- Delay de cinta/digital con tiempo libre o sincronizado al BPM, cinco divisiones rítmicas y ping-pong estéreo; reverb room/plate/hall, phaser, chorus y flanger.
- Envíos, activación y parámetros de cada efecto independientes para los siete canales.

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

Las pruebas comprueban aislamiento por canal, lifecycle y cleanup de los cinco efectos, STOP y `pagehide`, continuidad de envolventes, gestión de notas, recuperación del secuenciador y aislamiento de la caché. Incluyen diez minutos simulados a 190 BPM, los cinco efectos activos en los siete canales y pruebas específicas del J-4: creación diferida, cuatro voces, robo de voz, 4.000 cambios de parámetros y limpieza completa. Son simulaciones de gestión de recursos y señal; no miden la RAM ni los cortes del hilo de audio de Safari/Chrome. La escucha en dispositivos reales sigue siendo necesaria.

## Arquitectura de audio r13.0

- El J-4 crea su bloque común de LFO y chorus solo al tocar la primera nota. Cada voz aporta saw, pulse formada por waveshaping, suboscilador, HPF, dos lowpass en cascada y VCA con ADSR.
- La polifonía útil queda limitada a cuatro voces. La quinta nota roba la voz más antigua mediante un fundido de 9 ms; una voz retirada no puede volver a seleccionarse mientras termina ese fundido.
- Los parámetros de una voz viva reutilizan sus nodos y sustituyen automatizaciones anteriores. Release conserva el nivel alcanzado antes de caer y STOP elimina voces, moduladores, conexiones y temporizadores.
- El chorus propio del J-4 es estéreo y se mantiene separado del chorus de envío. El canal 07 pasa después por la misma cadena de procesador, volumen, panorama y FX independientes que el resto de la mesa.

- El master sigue exactamente esta ruta: **mezcla completa → limitador opcional → EQ creativo de cuatro filtros → volumen master → medidor → salida**.
- El limitador arranca apagado para que el master pueda trabajar sin limitar. Al activarlo ofrece threshold, attack, release y ceiling pre-EQ; su bypass cambia mediante una transición corta, sin reconectar el grafo de audio.
- El EQ master está deliberadamente después del limitador. Sus dos shelves de ±15 dB y los filtros pasa altos/pasa bajos pueden empujar la señal por encima del ceiling para conservar un efecto musical potente. No existe un segundo limitador oculto después del EQ.
- El volumen master está después del EQ y permite compensar esos realces. El medidor final muestra el pico post-EQ/post-volumen y mantiene encendido el aviso CLIP cuando la salida alcanza 0 dBFS.
- Los controles del master reutilizan siempre los mismos nodos y sustituyen la automatización anterior; moverlos repetidamente no crea procesadores nuevos ni historiales de eventos sin límite.

- Auto Cutoff usa un único LFO sinusoidal sincronizado al BPM con divisiones 1/1, 1/2, 1/2T, 1/4, 1/4T y 1/8. La modulación es unipolar: abre el filtro desde el cutoff manual sin empujarlo por debajo de su rango útil.
- El rango se adapta al margen disponible después del cutoff y del contorno de filtro. El LFO y su offset se crean solo al activarlo; cada voz conecta sus dos polos y los desconecta al terminar. STOP, `pagehide` o la desactivación retiran fuentes, conexiones y timers.

- Cada delay conserva por canal su modo FREE/SYNC, división rítmica y ping-pong. Los delays sincronizados siguen los cambios de BPM mediante rampas suaves; los delays libres mantienen su tiempo en milisegundos.
- El ping-pong alterna dos líneas de retardo independientes entre izquierda y derecha. Cambiarlo durante la reproducción cruza las rutas de feedback sin reconectar nodos ni producir saltos bruscos.

- Cada canal conserva su propio estado, envío y ruta FX. Cambiar los parámetros de un canal no modifica los nodos de los demás.
- Delay, chorus, phaser y flanger se crean bajo demanda y se desconectan después de sus colas. Sus LFO se detienen durante el cleanup.
- La reverb prepara una sola vez tres impulsos y tres convolvers compartidos. Cada canal activo aporta su propio send, damping y ganancias de selección room/plate/hall.
- Con los efectos apagados no existen procesadores ni envíos permanentes por canal. STOP retira rutas, timers y LFO, y cada voz terminada desconecta sus nodos.
- Los controles sustituyen su automatización anterior conservando el valor alcanzado y omiten objetivos repetidos.
- El filtro del delay usa una Q sin resonancia para que el feedback máximo permitido no amplifique sucesivamente algunas frecuencias. En los filtros lowpass/highpass de Web Audio, Q se expresa en dB: [especificación de los filtros](https://www.w3.org/TR/webaudio/#filters-characteristics).
- El osciloscopio reutiliza su buffer, los medidores se actualizan como máximo a 30 fps y su animación se detiene cuando no están visibles. Editar un paso de batería actualiza solamente ese botón.

Para la prueba auditiva, confirma que el pie de la app muestra **AUDIO r13.0**. En JUNO, mantén cuatro notas, añade una quinta y verifica que el robo de voz no produce clic. Recorre DCO, filtro, ADSR, LFO y los cuatro modos de chorus; después prueba el canal 07 en MEZCLA y FX. En MEZCLA, confirma también que el master conserva su comportamiento r12. Haz varios ciclos PLAY/STOP mientras suena: no debe haber saltos ni crujidos. Si aparece alguno, anota dispositivo, navegador, ajuste y momento exacto.
