const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, 'hair-salon-scissors.svg');
const svgBuffer = fs.readFileSync(svgPath);

const androidRes = path.join(__dirname, 'android-agenda', 'android', 'app', 'src', 'main', 'res');

const mipmapDirs = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

async function main() {
  for (const [dir, size] of Object.entries(mipmapDirs)) {
    const mipmapPath = path.join(androidRes, dir);
    if (fs.existsSync(mipmapPath)) {
      const png = await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toBuffer();
      fs.writeFileSync(path.join(mipmapPath, 'ic_launcher_foreground.png'), png);
      console.log(`Updated ${dir}/ic_launcher_foreground.png (${size}x${size})`);
    }
  }
  console.log('Android icons updated!');
}

main().catch(console.error);
