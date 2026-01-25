
const { TypstCompiler } = require('./dist/index.cjs');
const path = require('path');
const fs = require('fs');

async function run() {
    try {
        const wasmPath = path.resolve(__dirname, 'dist/wasm/typst_wasm_bg.wasm');
        const workerPath = path.resolve(__dirname, 'dist/worker.mjs');

        // Note: In Node.js environment, we need to pass absolute file paths if the loader supports file://
        // But for TypstCompiler (in Node), it expects URLs or paths that can be fetched/loaded.
        // The implementation in index.ts uses `new Worker(workerUrl)`. 
        // In Node (and Bun), passing an absolute path string works.
        // For WASM, `wasm-bindgen` generated code might try to fetch it if it's a URL, or load if it's a path.
        // But since we are using `bun`, `fetch` works for `file://` URLs.
        
        console.log('Initializing compiler...');
        console.log('WASM Path:', wasmPath);
        console.log('Worker Path:', workerPath);

        const compiler = new TypstCompiler(
            'file://' + wasmPath, 
            workerPath
        );
        
        console.log('Waiting for compiler to be ready...');
        await compiler.ready();
        console.log('Compiler ready!');

        const mainText = '#show: "Hello World"';
        
        console.log('Compiling...');
        const result = await compiler.compile({
            mainPath: 'main.typ',
            files: {
                'main.typ': new TextEncoder().encode(mainText)
            }
        });

        console.log('Compilation Result:', result);
        
        if (result.diagnostics && result.diagnostics.length > 0) {
            console.error('Diagnostics:', result.diagnostics);
        }
        
        if (result.svg) {
            console.log('SVG generated successfully (length: ' + result.svg.length + ')');
            // Write SVG to disk for inspection
            fs.writeFileSync('output.svg', result.svg);
            console.log('Wrote output.svg');
        }

    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

run();
