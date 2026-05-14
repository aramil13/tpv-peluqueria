const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, 'hair-salon-scissors.svg');
const svgBuffer = fs.readFileSync(svgPath);

const sizes = {
  'android-icon-48-ldpi': 48,
  'android-icon-48-mdpi': 48,
  'android-icon-72-hdpi': 72,
  'android-icon-96-xhdpi': 96,
  'android-icon-144-xxhdpi': 144,
  'android-icon-192-xxxhdpi': 192,
  'icon-16': 16,
  'icon-24': 24,
  'icon-32': 32,
  'icon-64': 64,
  'icon-128': 128,
  'icon-256': 256,
  'icon-512': 512,
};

async function main() {
  const outDir = path.join(__dirname, 'generated-icons');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  for (const [name, size] of Object.entries(sizes)) {
    const pngPath = path.join(outDir, `${name}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(pngPath);
    console.log(`Generated: ${pngPath} (${size}x${size})`);
  }

  // For Android: copy to mipmap directories
  const androidRes = path.join(__dirname, 'android-agenda', 'android', 'app', 'src', 'main', 'res');
  const mipmapDirs = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
  };

  for (const [dir, size] of Object.entries(mipmapDirs)) {
    const mipmapPath = path.join(androidRes, dir);
    if (fs.existsSync(mipmapPath)) {
      // Create ic_launcher.png and ic_launcher_round.png
      const pngPath = path.join(outDir, `icon-${size}.png`);
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(pngPath);
      fs.copyFileSync(pngPath, path.join(mipmapPath, 'ic_launcher.png'));
      fs.copyFileSync(pngPath, path.join(mipmapPath, 'ic_launcher_round.png'));
      console.log(`Copied to ${dir}/ic_launcher.png (${size}x${size})`);
    }
  }

  // For Windows: create icon-256.png for electron-builder (can use PNG)
  // Also try to make a simple .ico using PNG data
  const icon256 = path.join(outDir, 'icon-256.png');
  fs.copyFileSync(icon256, path.join(__dirname, 'icon.png'));
  console.log('Copied icon.png for Electron');

  console.log('Done!');
}

main().catch(console.error);
