import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";

export class PythonWorker {
  constructor() {
    this.pending = new Map(); this.sequence = 0; this.metadata = null; this.error = null;
    const python = process.env.PYTHON || (fs.existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3");
    this.child = spawn(python, ["-u", "-m", "ml.worker"], { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" } });
    this.child.stderr.on("data", data => { this.error = data.toString().trim(); process.stderr.write(data); });
    this.child.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("exit", code => this.fail(new Error(`ML worker exited (${code}); run .venv/bin/python -m ml.train`)));
    createInterface({ input: this.child.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.event === "ready") { this.metadata = message.metadata; this.error = null; return; }
        const task = this.pending.get(message.id);
        if (!task) return;
        this.pending.delete(message.id); clearTimeout(task.timeout);
        if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
      } catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    this.error = error.message; this.metadata = null;
    for (const task of this.pending.values()) { clearTimeout(task.timeout); task.reject(error); }
    this.pending.clear();
  }
  predict(features) {
    if (!this.metadata) return Promise.reject(Object.assign(new Error(this.error || "ML model is loading"), { status: 503 }));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("ML inference timed out")); }, 30000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, features })}\n`, error => { if (error) this.fail(error); });
    });
  }
  close() { this.child.kill(); }
}
