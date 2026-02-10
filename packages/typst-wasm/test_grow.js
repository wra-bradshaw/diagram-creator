const sab = new SharedArrayBuffer(1024, { maxByteLength: 1024 * 1024 });
console.log("Initial size:", sab.byteLength);
try {
  sab.grow(2048);
  console.log("After grow:", sab.byteLength);
  console.log("SUCCESS");
} catch (e) {
  console.log("ERROR:", e);
}