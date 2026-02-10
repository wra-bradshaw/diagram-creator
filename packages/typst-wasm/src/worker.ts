import { SharedMemoryCommunication, SharedMemoryCommunicationStatus } from "./protocol";
import { createPostMessage } from "./util.js";
import type { MainToWorkerMessage } from "./index";
import { TypstCompiler } from "./wasm";
import type { WasmDiagnostic } from "./wasm";

export type WorkerToMainMessage =
  | {
      kind: "compiled";
      payload: {
        svg: string;
        diagnostics: WasmDiagnostic[];
      };
    }
  | {
      kind: "compile_error";
      payload: {
        error: string;
        diagnostics: WasmDiagnostic[];
      };
    }
  | {
      kind: "web_fetch";
      payload: {
        path: string;
      };
    }
  | {
      kind: "ready";
      payload: undefined;
    };

let compiler: TypstCompiler | null = null;
let sharedMemoryCommunication: SharedMemoryCommunication | null = null;

const postMessage = createPostMessage<WorkerToMainMessage>();

declare global {
  function web_fetch(path: string): Uint8Array;
}

globalThis.web_fetch = (path) => {
  if (!sharedMemoryCommunication) {
    throw new Error("Communication buffer not initialized");
  }

  sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Pending);
  postMessage("web_fetch", {
    path,
  });

  Atomics.wait(new Int32Array(sharedMemoryCommunication.statusBuf), 0, SharedMemoryCommunicationStatus.Pending);

  const status = sharedMemoryCommunication.getStatus();
  if (status === SharedMemoryCommunicationStatus.Error) {
    throw new Error(`Failed to fetch: ${path}`);
  }

  return sharedMemoryCommunication.getBuffer();
};

self.onmessage = async (e: MessageEvent) => {
  const data = e.data as MainToWorkerMessage;

  switch (data.kind) {
    case "init":
      console.log("init received");
      sharedMemoryCommunication = SharedMemoryCommunication.hydrateObj(data.payload.sharedMemoryCommunication);
      console.log("creating wasm compiler...");
      compiler = new TypstCompiler();
      console.log("done");
      postMessage("ready", undefined);

      break;
    case "compile":
      if (!compiler) {
        postMessage("compile_error", { error: "Compiler not initialised", diagnostics: [] });
        return;
      }
      try {
        compiler.set_main(data.payload.mainPath);

        for (const [path, fileData] of Object.entries(data.payload.files)) {
          compiler.add_file(path, fileData);
        }

        const result = compiler.compile();

        postMessage("compiled", {
          svg: result.svg ?? "",
          diagnostics: result.diagnostics,
        });
      } catch (err) {
        console.error(err);
        postMessage("compile_error", {
          error: JSON.stringify(err),
          diagnostics: [],
        });
      }
      break;
    case "load_font":
      if (!compiler) {
        console.error("[Worker] Cannot load font: Compiler not initialised");
        return;
      }
      try {
        compiler.add_font(data.payload.data);
      } catch (err) {
        console.error("[Worker] Failed to load font:", err);
      }
      break;
  }
};
