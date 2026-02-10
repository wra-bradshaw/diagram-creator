const INITIAL_SAB_SIZE = 1024 * 1024; // 1MB
const MAX_SAB_SIZE = 4 * 1024 * 1024 * 1024; // 64GB

export const SharedMemoryCommunicationStatus = {
  None: 0,
  Pending: 1,
  Error: 2,
  Success: 3,
} as const;

export type SharedMemoryCommunicationStatus = (typeof SharedMemoryCommunicationStatus)[keyof typeof SharedMemoryCommunicationStatus];

export class SharedMemoryCommunication {
  dataBuf: SharedArrayBuffer;
  statusBuf: SharedArrayBuffer;
  sizeBuf: SharedArrayBuffer;

  constructor() {
    this.dataBuf = new SharedArrayBuffer(INITIAL_SAB_SIZE, { maxByteLength: MAX_SAB_SIZE });
    this.statusBuf = new SharedArrayBuffer(4);
    this.sizeBuf = new SharedArrayBuffer(4);
  }

  getStatus(): SharedMemoryCommunicationStatus {
    const uint8view = new Int32Array(this.statusBuf);
    return uint8view[0] as SharedMemoryCommunicationStatus;
  }

  setStatus(status: SharedMemoryCommunicationStatus) {
    const uint8view = new Int32Array(this.statusBuf);
    Atomics.store(uint8view, 0, status);
    Atomics.notify(uint8view, 0, 1);
    return;
  }

  setBuffer(buf: Uint8Array) {
    const needed = buf.byteLength;
    const current = this.dataBuf.byteLength;

    if (needed > current) {
      this.dataBuf.grow(needed);
    }

    const bufView = new Uint8Array(this.dataBuf);
    bufView.set(buf);

    // Store the actual data size
    const sizeView = new Int32Array(this.sizeBuf);
    Atomics.store(sizeView, 0, needed);
  }

  getBuffer() {
    // Read the actual data size and return only that portion
    const sizeView = new Int32Array(this.sizeBuf);
    const size = Atomics.load(sizeView, 0);
    return new Uint8Array(this.dataBuf, 0, size);
  }

  static hydrateObj(obj: SharedMemoryCommunication) {
    const instantiation = new SharedMemoryCommunication();
    instantiation.dataBuf = obj.dataBuf;
    instantiation.statusBuf = obj.statusBuf;
    instantiation.sizeBuf = obj.sizeBuf;
    return instantiation;
  }
}
