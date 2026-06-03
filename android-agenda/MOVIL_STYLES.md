# App Android TPV - Documentación de Estilos Móvil

## Viewport
```html
<meta name="viewport" content="width=device-width, initial-scale=0.5, maximum-scale=1.0, user-scalable=no">
```

## CSS Móvil (media query max-width: 768px)

```css
@media (max-width: 768px) {
  html { overflow-x: hidden; }
  body {
    transform-origin: top left;
    transform: scale(0.4);
    width: 250%;
    min-height: 100vh;
    display: block;
  }
```

## Características Principales

- **Sidebar**: 60px de ancho (solo iconos visibles, texto oculto)
- **Sin scale/zoom**: Vista normal de escritorio en pantalla móvil
- **Grids**: 1 columna en móvil
- **Stats Grid**: 2 columnas (1fr 1fr)

## URL de Sincronización
```javascript
function getSyncCfg() {
  return (data.settings && data.settings.sync)
    ? data.settings.sync
    : { enabled: true, url: 'https://nymaraestilistas.es' };
}
```

## Archivo Origen
`android-agenda/www/index.html`

## Para Recompilar
```bash
cd android-agenda
npx cap sync android
cd android
.\gradlew assembleDebug
```
Luego copiar `android/app/build/outputs/apk/debug/app-debug.apk` a `AgendaTPV.apk`