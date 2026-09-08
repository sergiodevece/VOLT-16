# VOLT/16

Groovebox para móvil y ordenador: batería de inspiración 808, bajo monofónico y dos secuenciadores de 16 pasos. El audio se genera en el navegador con Web Audio, sin muestras ni servidor de audio.

**[Abrir VOLT/16 en Netlify](https://volt-16-live-drum-machine-synth-bass.netlify.app/)** · [Código en GitHub](https://github.com/sergiodevece/VOLT-16)

## Tocar

1. Abre la app y pulsa **PLAY** para iniciar el audio.
2. Programa los pasos en **BATERÍA** y **BAJO**; ajusta el sonido del bajo en **SÍNTESIS**.
3. En **MEZCLA**, ajusta volumen, panorama, compresión y ecualización de cada canal.
4. En **FX**, selecciona el canal y ajusta sus envíos a los efectos.

Durante la reproducción, editar el bajo modifica el patrón sin disparar notas adicionales. En pausa se pueden preescuchar las notas.

## Sonido y controles

- Batería: bombo, caja, palmas, charles cerrado y abierto.
- Bajo: oscilador, suboscilador, filtro, envolvente, acento y slide.
- Tempo, tap tempo y swing.
- Por canal: compresor de inspiración óptica con gain y peak reduction; EQ con pasa altos, pasa bajos y dos shelving.
- Delay de cinta/digital, reverb room/plate/hall, phaser, chorus y flanger.
- Envíos independientes por canal. Los ajustes del procesador de cada efecto son compartidos entre los canales que lo utilizan.

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

Las pruebas comprueban la continuidad de la envolvente, la gestión de notas durante la edición, la recuperación del secuenciador y el aislamiento de la caché. Son comprobaciones de código; la escucha en dispositivos reales sigue siendo necesaria.
