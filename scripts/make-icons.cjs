// Renders build/icon.svg into the PNG files that the packager and the app use.
// Run with:  npm run icons   (Electron is used as the SVG renderer)
//
//   build/icon.png      1024 px  - electron-builder derives .ico and .icns from it
//   resources/icon.png   256 px  - window icon on Linux

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8')

async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <div style="width:${size}px;height:${size}px">${svg}</div></body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const image = await win.webContents.capturePage()
  win.destroy()
  // The capture is taken at the display's scale factor; bring it to the exact size.
  return image.resize({ width: size, height: size, quality: 'best' })
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
    const large = await render(1024)
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'build', 'icon.png'), large.toPNG())
    fs.writeFileSync(
      path.join(root, 'resources', 'icon.png'),
      large.resize({ width: 256, height: 256, quality: 'best' }).toPNG()
    )
    console.log('Wrote build/icon.png and resources/icon.png')
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
