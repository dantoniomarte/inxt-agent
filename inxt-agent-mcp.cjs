// Launcher for the inxt-agent MCP server (keeps mcp.json simple; resolves node + dist).
const { spawn } = require('node:child_process');
const path = require('node:path');
const child = spawn(process.execPath, [path.join(__dirname, 'dist', 'mcp', 'server.js')], {
  stdio: 'inherit',
  cwd: __dirname,
});
child.on('error', () => process.exit(127));
child.on('exit', (code, signal) => {
  if (typeof code === 'number') process.exit(code);
  process.kill(process.pid, signal || 'SIGTERM');
});
