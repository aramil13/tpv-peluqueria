# Convenciones android-agenda

## APK compilada
- Tras compilar, la APK final se copia a `android-agenda\AgendaTPV.apk` (NO a la raiz del repo).
- Compilar: `npx cap copy` en `android-agenda/` y luego `gradlew.bat assembleDebug` en `android-agenda/android/`.
- Origen del APK: `android-agenda\android\app\build\outputs\apk\debug\app-debug.apk`.

## iOS (Capacitor)
- Plataforma iOS anadida en ios/ (Capacitor 8). App ID com.tpv.agenda, nombre AgendaTPV.
- La app es web pura; no requiere plugins nativos adicionales. Permisos iOS ya declarados en ios/App/App/Info.plist (camara, fototeca, ATS para HTTP local).
- Compilar/abrir: en macOS con Xcode instalado:
  - npx cap sync ios (copia www -> ios)
  - npx cap open ios (abre Xcode) y compilar (Product > Archive) o xcodebuild.
- En Windows no se puede compilar iOS; solo se puede regenerar/sincronizar el proyecto web.
- Tras cambiar www, ejecutar npx cap copy ios (o sync) antes de compilar.
