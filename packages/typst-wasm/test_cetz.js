// Polyfill for TextDecoder/TextEncoder which might be missing/behaving differently in some environments
if (typeof TextDecoder === 'undefined') {
    const { TextDecoder, TextEncoder } = require('util');
    global.TextDecoder = TextDecoder;
    global.TextEncoder = TextEncoder;
}

const { TypstCompiler } = require('./dist/index.cjs');
const path = require('path');
const fs = require('fs');

async function run() {
    try {
        const wasmPath = path.resolve(__dirname, 'dist/wasm/typst_wasm_bg.wasm');
        const workerPath = path.resolve(__dirname, 'dist/worker.mjs');

        const compiler = new TypstCompiler(
            'file://' + wasmPath, 
            workerPath
        );
        
        await compiler.ready();
        console.log('Compiler ready!');

        const typstCode = `
#import "@preview/cetz:0.4.2": canvas, draw
#import "@preview/cetz-plot:0.1.3": chart

#set page(width: auto, height: auto, margin: .5cm)

#let data2 = (
  ([15-24], 18.0, 20.1, 23.0, 17.0),
  ([25-29], 16.3, 17.6, 19.4, 15.3),
  ([30-34], 14.0, 15.3, 13.9, 18.7),
  ([35-44], 35.5, 26.5, 29.4, 25.8),
  ([45-54], 25.0, 20.6, 22.4, 22.0),
  ([55+],   19.9, 18.2, 19.2, 16.4),
)

#canvas({
  draw.set-style(legend: (fill: white), barchart: (bar-width: .8, cluster-gap: 0))
  chart.barchart(mode: "clustered",
                 size: (9, auto),
                 label-key: 0,
                 value-key: (..range(1, 5)),
                 x-tick-step: 2.5,
                 data2,
                 labels: ([Low], [Medium], [High], [Very high]),
                 legend: "inner-north-east",)
})
`;
        
        console.log('Compiling Cetz example...');
        const result = await compiler.compile({
            mainPath: 'main.typ',
            files: {
                'main.typ': new TextEncoder().encode(typstCode)
            }
        });

        console.log('Compilation Result:', result);
        
        if (result.diagnostics && result.diagnostics.length > 0) {
            console.error('Diagnostics:', result.diagnostics);
        }
        
        if (result.svg) {
            console.log('SVG generated successfully (length: ' + result.svg.length + ')');
            fs.writeFileSync('cetz_output.svg', result.svg);
            console.log('Wrote cetz_output.svg');
        }

    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

run();
