const fs = require('fs');
const path = require('path');

const src = 'C:\\Users\\Дорогу молодым\\Desktop\\autonomous-deploy.skill';
const destDir = 'C:\\Users\\Дорогу молодым\\Desktop\\Claude Code\\skills';
const dest = path.join(destDir, 'autonomous-deploy.skill');

try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  fs.unlinkSync(src);
  // Clean up desktop temp files
  ['make-skill.js','make-skill2.js','pack_result.txt','pack_result2.txt','move-skill.js'].forEach(f => {
    try { fs.unlinkSync('C:\\Users\\Дорогу молодым\\Desktop\\' + f); } catch(_) {}
  });
  fs.writeFileSync(path.join(__dirname, 'move-skill.log'), 'OK: ' + dest);
} catch(e) {
  fs.writeFileSync(path.join(__dirname, 'move-skill.log'), 'ERROR: ' + e.message);
}
