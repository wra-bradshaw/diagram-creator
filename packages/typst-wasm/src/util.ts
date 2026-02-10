interface Message {
  kind: string;
  payload: unknown;
}

export function createPostMessage<T extends Message>() {
  return (kind: T["kind"], payload: T["payload"]) =>
    self.postMessage({
      kind,
      payload,
    });
}
