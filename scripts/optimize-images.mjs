import sharp from 'sharp'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = new URL('..', import.meta.url).pathname
const PUBLIC = join(ROOT, 'public')

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB'
}

async function run() {
  // ── Favicon ────────────────────────────────────────────────────────────
  const faviconSrc = join(ROOT, 'peakform-favicon.png')
  const faviconSizes = [
    { size: 16,  name: 'favicon-16.png' },
    { size: 32,  name: 'favicon-32.png' },
    { size: 180, name: 'apple-touch-icon.png' },
    { size: 192, name: 'icon-192.png' },
    { size: 512, name: 'icon-512.png' },
  ]

  console.log('\n── Favicon ──────────────────────────────────────────')
  console.log('Quelle:', kb(statSync(faviconSrc).size))
  for (const { size, name } of faviconSizes) {
    const dest = join(PUBLIC, name)
    await sharp(faviconSrc)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(dest)
    console.log(`  ${name}: ${kb(statSync(dest).size)}`)
  }

  // ── Logo (Schriftzug) ──────────────────────────────────────────────────
  const logoSrc = join(ROOT, 'peakform-complete.png')
  const logoMeta = await sharp(logoSrc).metadata()
  console.log('\n── Logo (Schriftzug) ────────────────────────────────')
  console.log(`Quelle: ${kb(statSync(logoSrc).size)} (${logoMeta.width}×${logoMeta.height})`)

  // 1x: max-width 320px, max-height 80px — proportional
  const logo1x = join(PUBLIC, 'peakform-logo.png')
  await sharp(logoSrc)
    .resize(320, 80, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(logo1x)
  console.log(`  peakform-logo.png (1x): ${kb(statSync(logo1x).size)}`)

  // 2x: doppelte Pixel
  const logo2x = join(PUBLIC, 'peakform-logo@2x.png')
  await sharp(logoSrc)
    .resize(640, 160, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(logo2x)
  console.log(`  peakform-logo@2x.png: ${kb(statSync(logo2x).size)}`)

  // ── Splash / Hintergrundbild ───────────────────────────────────────────
  const splashSrc = join(ROOT, 'schmausbaersyndicate.png')
  const splashMeta = await sharp(splashSrc).metadata()
  console.log('\n── Splash-Bild ──────────────────────────────────────')
  console.log(`Quelle: ${kb(statSync(splashSrc).size)} (${splashMeta.width}×${splashMeta.height})`)

  // PNG 1024×1024 quadratisch für PWA splash
  const splash = join(PUBLIC, 'splash.png')
  await sharp(splashSrc)
    .resize(1024, 1024, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toFile(splash)
  console.log(`  splash.png: ${kb(statSync(splash).size)}`)

  // JPEG 1200px Breite für Home-Hintergrund
  const splashBg = join(PUBLIC, 'splash-bg.jpg')
  await sharp(splashSrc)
    .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(splashBg)
  console.log(`  splash-bg.jpg: ${kb(statSync(splashBg).size)}`)

  console.log('\n✓ Alle Bilder optimiert → public/')
}

run().catch(err => { console.error(err); process.exit(1) })
