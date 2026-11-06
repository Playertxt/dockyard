// Renders the Lookout icon with Electron and writes build/icon.png + src/assets/icon.png.
// Run with: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c" width="512" height="512"></canvas>
<script>
const c = document.getElementById('c'), x = c.getContext('2d');
function rr(X,Y,W,H,R){x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+W,Y,X+W,Y+H,R);x.arcTo(X+W,Y+H,X,Y+H,R);x.arcTo(X,Y+H,X,Y,R);x.arcTo(X,Y,X+W,Y,R);x.closePath();}
rr(24,24,464,464,112);
let g = x.createLinearGradient(0,24,0,488); g.addColorStop(0,'#1fc8b0'); g.addColorStop(1,'#0b6f78'); x.fillStyle=g; x.fill();
x.save(); rr(24,24,464,464,112); x.clip();
x.fillStyle='rgba(255,255,255,.08)'; x.beginPath(); x.arc(120,90,260,0,Math.PI*2); x.fill();
x.restore();
// lens ring
x.lineWidth = 34; x.strokeStyle = '#ffffff';
x.beginPath(); x.arc(228,228,128,0,Math.PI*2); x.stroke();
// handle
x.lineCap = 'round'; x.lineWidth = 46;
x.beginPath(); x.moveTo(326,326); x.lineTo(410,410); x.stroke();
// pulse line inside the lens
x.save(); x.beginPath(); x.arc(228,228,108,0,Math.PI*2); x.clip();
x.fillStyle = 'rgba(255,255,255,.16)'; x.fillRect(0,0,512,512);
x.lineWidth = 20; x.lineJoin = 'round'; x.strokeStyle = '#ffd166';
x.beginPath(); x.moveTo(100,240); x.lineTo(165,240); x.lineTo(195,180); x.lineTo(240,290); x.lineTo(272,212); x.lineTo(296,240); x.lineTo(360,240); x.stroke();
x.restore();
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 400));
  const dataUrl = await win.webContents.executeJavaScript('document.getElementById("c").toDataURL("image/png")');
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const root = path.join(__dirname, '..');
  fs.mkdirSync(path.join(root, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), buf);
  fs.writeFileSync(path.join(root, 'src', 'assets', 'icon.png'), buf);
  console.log('icon written', buf.length, 'bytes');
  app.quit();
});
