/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${url}`)), 30_000);
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        clearTimeout(timeout);
        resolve();
      });
      request.on("error", () => setTimeout(attempt, 200));
    };
    attempt();
  });
}

async function main() {
  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const root = path.resolve(__dirname, "..");
  const next = spawn("pnpm", ["exec", "next", "dev", "-p", String(port)], { cwd: root, stdio: "inherit" });
  let electron;
  const stop = () => {
    if (next.exitCode === null) next.kill();
    if (electron?.exitCode === null) electron.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await waitForServer(url);
    electron = spawn("pnpm", ["exec", "electron", "."], {
      cwd: root,
      env: { ...process.env, VIBERON_DEV_SERVER_URL: url },
      stdio: "inherit"
    });
    electron.on("exit", (code) => {
      if (next.exitCode === null) next.kill();
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    stop();
    throw error;
  }
}

void main();
