const { existsSync } = require('node:fs');
const { execSync, spawn } = require('node:child_process');

function run(command) {
  execSync(command, { stdio: 'inherit' });
}

if (!existsSync('package.json')) {
  run('git clone https://github.com/DWAA1660/pocketplan.git _source && cp -R _source/. . && rm -rf _source');
} else {
  run('git pull --ff-only');
}

if (!existsSync('node_modules')) run('npm ci');
run('npm run build');
run('yes | npm run db:local');

const child = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '--local',
    '--ip',
    '0.0.0.0',
    '--port',
    process.env.SERVER_PORT || '3178',
    '-c',
    'wrangler.local.jsonc',
  ],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      PUBLIC_SITE_URL:
        process.env.PUBLIC_SITE_URL || 'http://node55.lunes.host:3178',
    },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
