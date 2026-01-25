const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/wasm/typst_wasm.js');

try {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Check if already patched
    if (content.includes('// import * as import1 from "bridge"')) {
        console.log('typst_wasm.js already patched.');
        process.exit(0);
    }

    // remove import
    content = content.replace(
        'import * as import1 from "bridge"', 
        '// import * as import1 from "bridge"'
    );
    
    // update __wbg_get_imports to use provided bridge
    const oldGetImports = `function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {`;

    const newGetImports = `function __wbg_get_imports(imports_or_memory) {
    let memory;
    let bridge;
    if (imports_or_memory && imports_or_memory.env && imports_or_memory.env.memory) {
        memory = imports_or_memory.env.memory;
        bridge = imports_or_memory.bridge;
    } else {
        memory = imports_or_memory;
    }

    const import0 = {
        __proto__: null,
        __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {`;

    content = content.replace(oldGetImports, newGetImports);

    // update return to use bridge var
    content = content.replace(
        '"bridge": import1,',
        '"bridge": bridge,'
    );

    const oldMemory = 'memory: memory || new WebAssembly.Memory({initial:135,maximum:135,shared:true}),';
    const newMemory = 'memory: memory || new WebAssembly.Memory({initial:2048,maximum:4096,shared:true}),';
    content = content.replace(oldMemory, newMemory);

    fs.writeFileSync(filePath, content);
    console.log('Successfully patched typst_wasm.js');

} catch (err) {
    console.error('Failed to patch typst_wasm.js:', err);
    process.exit(1);
}
