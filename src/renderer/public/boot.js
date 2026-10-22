// Sketchbook pre-bundle boot script. Loaded as a classic <script> before the
// app bundle (CSP forbids inline scripts), so it runs before Excalidraw and
// browser-fs-access evaluate.
;(function () {
  'use strict'

  // Excalidraw loads its fonts from `${EXCALIDRAW_ASSET_PATH}fonts/...`.
  // Point it at our own bundled copy (app://bundle/fonts/...), never a CDN.
  window.EXCALIDRAW_ASSET_PATH = new URL('./', location.href).href

  // Hide the File System Access API. browser-fs-access detects support with
  // `'showOpenFilePicker' in self`; once these are gone it falls back to
  // <a download> (handled natively by the main process via `will-download`)
  // and <input type=file>.
  var names = ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    var obj = window
    // Walk the prototype chain: the methods may live on the instance or a prototype.
    while (obj && name in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, name)) {
        try {
          delete obj[name]
        } catch {
          /* ignore */
        }
        if (Object.prototype.hasOwnProperty.call(obj, name)) {
          // Not configurable: best effort, make it unusable.
          try {
            Object.defineProperty(obj, name, { value: undefined, configurable: true })
          } catch {
            /* ignore */
          }
          break
        }
      }
      obj = Object.getPrototypeOf(obj)
    }
  }
})()
