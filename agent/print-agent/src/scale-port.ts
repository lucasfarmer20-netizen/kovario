import { spawn, execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { promisify } from "node:util";
/** OS serial access avoids native addons in the single-binary agent. */
export async function openScalePort(
  path: string,
  onData: (chunk: Buffer) => void,
  onError: () => void,
): Promise<() => void> {
  if (process.platform === "win32") {
    if (!/^COM[1-9]\d*$/i.test(path)) throw new Error("Expected COM port");
    // Port name is passed as a process environment value, never interpolated as code.
    const command = `$ErrorActionPreference='Stop'; $p=New-Object System.IO.Ports.SerialPort($env:FILLETRY_SCALE_PORT,9600,[System.IO.Ports.Parity]::None,8,[System.IO.Ports.StopBits]::One); try { $p.Open(); while($true) { $p.Write('W'); Start-Sleep -Milliseconds 500; $text=$p.ReadExisting(); if($text.Length -gt 0){ [Console]::Write($text); [Console]::Out.Flush() } } } finally { if($p.IsOpen){$p.Close()}; $p.Dispose() }`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      env: { ...process.env, FILLETRY_SCALE_PORT: path },
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", onData);
    child.on("error", onError);
    let stopping = false;
    child.on("exit", () => {
      if (!stopping) onError();
    });
    return () => {
      stopping = true;
      child.kill();
    };
  }
  if (!/^\/dev\/[A-Za-z0-9_./-]+$/.test(path) || path.includes(".."))
    throw new Error("Expected serial device path");
  await promisify(execFile)("stty", [
    process.platform === "darwin" ? "-f" : "-F",
    path,
    "9600",
    "cs8",
    "-cstopb",
    "-parenb",
    "raw",
    "-echo",
  ]);
  const input = createReadStream(path),
    output = createWriteStream(path);
  input.on("data", (chunk) => onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  input.on("error", onError);
  output.on("error", onError);
  const timer = setInterval(() => output.write("W"), 500);
  return () => {
    clearInterval(timer);
    input.destroy();
    output.destroy();
  };
}
