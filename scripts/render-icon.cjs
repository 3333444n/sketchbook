/* eslint-disable @typescript-eslint/no-require-imports */
// Rasterise build/icon.svg to a transparent 1024x1024 PNG using Electron's Chromium.
// Usage: electron scripts/render-icon.cjs <in.svg> <out.png>
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('fs')

const [input, output] = process.argv.slice(-2)

app.disableHardwareAcceleration()
app.dock?.hide()

app.whenReady().then(async () => {
  const svg = readFileSync(input, 'utf8')
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    img{display:block;width:1024px;height:1024px}
  </style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 }
  })
  win.webContents.setZoomFactor(1)
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  await win.webContents.executeJavaScript('document.querySelector("img").decode()')
  await new Promise((r) => setTimeout(r, 300))
  let image = await win.webContents.capturePage()
  const size = image.getSize()
  if (size.width !== 1024) image = image.resize({ width: 1024, height: 1024, quality: 'best' })
  writeFileSync(output, image.toPNG())
  app.quit()
})
