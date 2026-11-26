/**
 * transcribe — local speech-to-text for a media file, OS-independent.
 *
 * The engine is platform-specific and there is no single binary that exists on
 * both: macOS runs `mlx_whisper` (Apple-Silicon GPU via MLX), Linux runs
 * `whisper-ctranslate2` (faster-whisper on CPU, int8). Same Whisper models
 * either way, so the transcript is comparable; only the speed differs. Pick at
 * runtime rather than at build time, because the same checkout runs on both.
 *
 * Decoding goes through ffmpeg, so anything ffmpeg reads works — including the
 * OGG/Opus voice notes WhatsApp delivers.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

export interface TranscriptionResult {
  text: string;
  engine: string;
  model: string;
  language: string | null;
  durationMs: number;
}

/** Resolve a binary without assuming the caller's PATH — MCP/agent shells are
 *  frequently minimal, which is how this class of bug hides. */
async function which(bin: string): Promise<string | null> {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, bin);
    try {
      await fs.promises.access(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function transcribeFile(
  audioPath: string,
  opts: { model?: string; language?: string | null } = {},
): Promise<TranscriptionResult> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`audio file not found: ${audioPath}`);
  }
  if (!(await which("ffmpeg"))) {
    throw new Error("ffmpeg not found on PATH — required to decode the audio");
  }

  const started = Date.now();
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "wa-transcribe-"),
  );

  try {
    let engine: string;
    let model: string;
    let args: string[];
    let bin: string;

    const mlx = process.platform === "darwin" ? await which("mlx_whisper") : null;
    if (mlx) {
      engine = "mlx-whisper";
      model = opts.model ?? "mlx-community/whisper-large-v3-turbo";
      bin = mlx;
      args = [
        audioPath,
        "--model", model,
        "--output-dir", workDir,
        "--output-name", "out",
        "--output-format", "txt",
        "--verbose", "False",
      ];
      if (opts.language) args.push("--language", opts.language);
    } else {
      const ct2 = await which("whisper-ctranslate2");
      if (!ct2) {
        throw new Error(
          "no transcription engine found: install `mlx-whisper` (macOS) or `whisper-ctranslate2` (Linux)",
        );
      }
      engine = "whisper-ctranslate2";
      model = opts.model ?? "large-v3-turbo";
      bin = ct2;
      // int8 on CPU is the whole point: float32 is ~4x slower for no accuracy
      // gain that matters on a voice note.
      args = [
        audioPath,
        "--model", model,
        "--device", "cpu",
        "--compute_type", "int8",
        "--threads", String(os.cpus().length),
        "--output_dir", workDir,
        "--output_format", "txt",
        "--verbose", "False",
      ];
      if (opts.language) args.push("--language", opts.language);
    }

    await run(bin, args, { maxBuffer: 32 * 1024 * 1024 });

    const produced = (await fs.promises.readdir(workDir)).filter((f) =>
      f.endsWith(".txt"),
    );
    if (produced.length === 0) {
      throw new Error(`${engine} produced no transcript`);
    }
    const raw = await fs.promises.readFile(
      path.join(workDir, produced[0]),
      "utf8",
    );

    return {
      text: raw.trim(),
      engine,
      model,
      language: opts.language ?? null,
      durationMs: Date.now() - started,
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
