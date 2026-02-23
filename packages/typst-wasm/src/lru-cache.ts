class Node<K, V> {
  next: Node<K, V> | null;
  prev: Node<K, V> | null;
  k: K;
  v: V;

  constructor(k: K, v: V) {
    this.next = null;
    this.prev = null;
    this.k = k;
    this.v = v;
  }
}

export class LRUCache<K, V> {
  private head: Node<K, V> | null;
  private tail: Node<K, V> | null;
  private capacity: number;
  private map: Map<K, Node<K, V>>;

  constructor(capacity: number) {
    this.head = null;
    this.tail = null;
    this.capacity = capacity;
    this.map = new Map();
  }

  private remove(node: Node<K, V>) {
    this.map.delete(node.k);

    const prev = node.prev;
    const next = node.next;
    if (prev !== null) {
      prev.next = next;
    }
    if (next !== null) {
      next.prev = prev;
    }

    if (this.head === node) {
      this.head = next;
    }
    if (this.tail === node) {
      this.tail = prev;
    }
  }

  private add(node: Node<K, V>) {
    this.map.set(node.k, node);
    if (this.tail === null) {
      this.tail = node;
    }

    node.prev = null;
    node.next = this.head;
    if (this.head !== null) {
      this.head.prev = node;
    }
    this.head = node;
  }

  put(k: K, v: V) {
    const existingNode = this.map.get(k);
    if (existingNode !== undefined) {
      this.remove(existingNode);
    }

    const node = new Node(k, v);
    this.add(node);

    if (this.map.size > this.capacity && this.tail !== null) {
      this.remove(this.tail);
    }
  }

  get(k: K): V | undefined {
    const node = this.map.get(k);
    if (node !== undefined) {
      this.remove(node);
      this.add(node);
      return node.v;
    }
    return undefined;
  }
}
