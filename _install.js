const { execSync } = require('child_process');
const path = require('path');
const dir = path.join(__dirname);
console.log('Installing in:', dir);
try {
  execSync('npm install', { cwd: dir, stdio: 'inherit', timeout: 180000 });
  console.log('\nDone!');
} catch(e) {
  console.error('Install failed:', e.message);
}
